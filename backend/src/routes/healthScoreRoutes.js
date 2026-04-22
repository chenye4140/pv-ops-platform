const express = require('express');
const router = express.Router();
const healthScoreService = require('../services/healthScoreService');
const { authenticate } = require('../middleware/authMiddleware');

router.use(authenticate);

// GET /api/health-score/:stationId — health score for a single station
router.get('/:stationId', (req, res) => {
  try {
    const result = healthScoreService.getStationHealthScore(req.params.stationId);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Station not found' });
    }
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/health-score/all — health scores for all stations
router.get('/all', (req, res) => {
  try {
    const results = healthScoreService.getAllStationHealthScores();
    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
