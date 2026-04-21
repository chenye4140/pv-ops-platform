const express = require('express');
const router = express.Router();
const { db } = require('../models/database');

// GET /api/analysis/station/:id/anomaly
// Returns anomaly analysis results for a station
router.get('/station/:id/anomaly', (req, res) => {
  try {
    const stationId = req.params.id;

    // Get abnormal strings with their power data
    const abnormalStrings = db.prepare(`
      SELECT s.id, s.name, s.status, s.rated_power_w,
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
        abnormal_strings: abnormalStrings.map(s => ({
          id: s.id,
          name: s.name,
          status: s.status,
          rated_power_w: s.rated_power_w,
          latest_power_w: s.latest_power || 0,
          efficiency_loss: s.rated_power_w > 0 ? Math.round((1 - (s.latest_power || 0) / s.rated_power_w) * 100) : 0
        })),
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
// MVP: returns mock analysis results
router.post('/defect-image', (req, res) => {
  try {
    // In full implementation, this would process an uploaded image
    // through a defect detection ML model
    const mockResult = {
      success: true,
      data: {
        defects: [
          {
            type: 'hot_spot',
            confidence: 0.92,
            bounding_box: { x: 120, y: 80, width: 45, height: 35 },
            severity: 'high'
          },
          {
            type: 'crack',
            confidence: 0.78,
            bounding_box: { x: 300, y: 200, width: 60, height: 20 },
            severity: 'medium'
          }
        ],
        overall_health: 'degraded',
        recommendation: '建议现场巡检确认热斑缺陷，及时更换受损组件'
      }
    };
    res.json(mockResult);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
