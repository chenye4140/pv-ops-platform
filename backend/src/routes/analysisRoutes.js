const express = require('express');
const router = express.Router();

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
