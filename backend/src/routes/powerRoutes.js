const express = require('express');
const router = express.Router();
const powerDataService = require('../services/powerDataService');

// GET /api/power-data?stringId=&startTime=&endTime=
router.get('/', (req, res) => {
  try {
    const { stringId, startTime, endTime } = req.query;

    if (!stringId) {
      return res.status(400).json({ success: false, error: 'stringId is required' });
    }

    const data = powerDataService.getByStringId(stringId, startTime, endTime);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
