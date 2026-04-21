const express = require('express');
const router = express.Router();
const weatherService = require('../services/weatherService');

// GET /api/weather?stationId=&startTime=&endTime=
router.get('/', (req, res) => {
  try {
    const { stationId, startTime, endTime } = req.query;

    if (!stationId) {
      return res.status(400).json({ success: false, error: 'stationId is required' });
    }

    const data = weatherService.getByStationId(stationId, startTime, endTime);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
