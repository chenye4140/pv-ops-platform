const express = require('express');
const router = express.Router();
const { db } = require('../models/database');
const { analyzeDefectImage, isConfigured } = require('../services/aiService');
const { authenticate } = require('../middleware/authMiddleware');

router.use(authenticate);

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

module.exports = router;
