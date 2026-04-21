const express = require('express');
const router = express.Router();
const weatherService = require('../services/weatherService');
const { authenticate } = require('../middleware/authMiddleware');

router.use(authenticate);

// GET /api/weather?stationId=&start=&startTime=&end=&endTime=
router.get('/', (req, res) => {
  try {
    const { stationId, start, startTime, end, endTime } = req.query;

    if (!stationId) {
      return res.status(400).json({ success: false, error: 'stationId is required' });
    }

    // Accept both 'start/end' and 'startTime/endTime' param names
    const data = weatherService.getByStationId(stationId, startTime || start, endTime || end);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
