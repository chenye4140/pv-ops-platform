const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db } = require('../models/database');
const { analyzeDefectImage, isConfigured } = require('../services/aiService');
const auditService = require('../services/auditService');
const { authenticate } = require('../middleware/authMiddleware');

router.use(authenticate);

function getUserId(req) {
  return req.user ? req.user.id : null;
}

// Multer storage config
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `defect_${timestamp}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    cb(null, ext);
  },
});

// ---------------------------------------------------------------------------
// POST /api/analysis/upload — Upload image file for AI defect analysis
// ---------------------------------------------------------------------------

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '缺少图像文件 (支持 JPG/PNG/WebP)' });
    }

    // Convert uploaded file to base64 data URL
    const mimeType = req.file.mimetype || 'image/jpeg';
    const fileBuffer = fs.readFileSync(req.file.path);
    const base64 = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;

    const label = req.body.label || req.file.originalname;
    const stationId = req.body.station_id ? parseInt(req.body.station_id) : null;

    // Run AI analysis
    const result = await analyzeDefectImage(base64, label);

    // Persist result
    const userId = getUserId(req);
    const relPath = `uploads/${req.file.filename}`;
    const insertResult = db.prepare(`
      INSERT INTO defect_analyses (station_id, image_label, image_path, defects, overall_health, recommendation, model_used, analyzed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stationId,
      label,
      relPath,
      JSON.stringify(result.defects),
      result.overall_health,
      result.recommendation,
      result.model_used,
      userId,
    );

    auditService.logAction(userId, 'upload', 'analysis', insertResult.lastInsertRowid, { label, station_id: stationId, model_used: result.model_used }, req.ip);

    res.json({
      success: true,
      data: {
        image_path: relPath,
        defects: result.defects,
        overall_health: result.overall_health,
        recommendation: result.recommendation,
        model_used: result.model_used,
      },
    });
  } catch (error) {
    console.error('[Analysis] Upload error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/analysis/station/:id/anomaly
// Returns anomaly analysis results for a station
router.get('/station/:id/anomaly', (req, res) => {
  try {
    const stationId = req.params.id;

    // Get abnormal strings with their power data
    const abnormalStrings = db.prepare(`
      SELECT s.id, s.name, s.status, s.rated_power_w, s.panel_count,
             pd.power_w as latest_power, pd.voltage_v, pd.current_a,
             pd.timestamp
      FROM strings s
      JOIN inverters i ON s.inverter_id = i.id
      LEFT JOIN power_data pd ON s.id = pd.string_id
      WHERE i.station_id = ? AND s.status = 'abnormal'
      AND pd.timestamp = (SELECT MAX(timestamp) FROM power_data WHERE string_id = s.id)
      ORDER BY pd.power_w ASC
    `).all(stationId);

    // Get overall stats
    const stats = db.prepare(`
      SELECT COUNT(*) as total_strings,
             SUM(CASE WHEN s.status = 'abnormal' THEN 1 ELSE 0 END) as abnormal_count
      FROM strings s
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ?
    `).get(stationId);

    res.json({
      success: true,
      data: {
        station_id: stationId,
        total_strings: stats.total_strings,
        abnormal_count: stats.abnormal_count,
        abnormal_strings: abnormalStrings.map(s => {
          const stringRatedPower = s.rated_power_w * (s.panel_count || 1);
          const power = s.latest_power || 0;
          const loss = stringRatedPower > 0 ? Math.max(0, Math.round((1 - power / stringRatedPower) * 100)) : 0;
          return {
            id: s.id,
            name: s.name,
            status: s.status,
            rated_power_w: stringRatedPower,
            latest_power_w: power,
            efficiency_loss: loss
          };
        }),
        recommendations: [
          '建议对异常组串进行现场巡检',
          '检查接线盒和连接器是否有松动或腐蚀',
          '使用红外热像仪确认热斑位置'
        ]
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/analysis/defect-image
// Analyzes uploaded PV defect images using qwen-vl-max (or mock if no API key)
router.post('/defect-image', async (req, res) => {
  try {
    const { image, label } = req.body;

    if (!image) {
      return res.status(400).json({ success: false, error: '缺少图像数据' });
    }

    const result = await analyzeDefectImage(image, label || '未知图片');

    // Persist analysis result to defect_analyses table
    const userId = getUserId(req);
    const stationId = req.body.station_id || null;

    const insertResult = db.prepare(`
      INSERT INTO defect_analyses (station_id, image_label, defects, overall_health, recommendation, model_used, analyzed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      stationId,
      label || null,
      JSON.stringify(result.defects),
      result.overall_health,
      result.recommendation,
      result.model_used,
      userId
    );

    auditService.logAction(userId, 'upload', 'analysis', insertResult.lastInsertRowid, { label, station_id: stationId, model_used: result.model_used }, req.ip);

    // Map the AI service result to the expected frontend format
    const response = {
      success: true,
      data: {
        defects: result.defects.map(d => ({
          type: d.type,
          confidence: d.confidence,
          bounding_box: d.bounding_box || { x: 0, y: 0, width: 100, height: 100 },
          severity: d.severity,
          description: d.description || ''
        })),
        overall_health: result.overall_health,
        recommendation: result.recommendation,
        model_used: result.model_used
      }
    };

    res.json(response);
  } catch (error) {
    console.error('[Analysis] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/analysis/history — Retrieve analysis history
router.get('/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const stationId = req.query.station_id;
    const health = req.query.health;

    let sql = `
      SELECT da.*, s.name as station_name
      FROM defect_analyses da
      LEFT JOIN stations s ON da.station_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (stationId) {
      sql += ' AND da.station_id = ?';
      params.push(stationId);
    }
    if (health) {
      sql += ' AND da.overall_health = ?';
      params.push(health);
    }

    sql += ' ORDER BY da.created_at DESC LIMIT ?';
    params.push(limit);

    const analyses = db.prepare(sql).all(...params).map(a => ({
      ...a,
      defects: JSON.parse(a.defects || '[]'),
    }));

    res.json({ success: true, data: analyses });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
