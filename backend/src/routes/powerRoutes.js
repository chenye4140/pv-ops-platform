const express = require('express');
const router = express.Router();
const powerDataService = require('../services/powerDataService');
const wsService = require('../services/websocketService');
const { authenticate, requireStationAccess } = require('../middleware/authMiddleware');

router.use(authenticate);
router.use(requireStationAccess);

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

// POST /api/power-data - ingest new power reading
router.post('/', (req, res) => {
  try {
    const record = powerDataService.create(req.body);
    // Broadcast to "power-data" topic with optional room
    wsService.broadcast('new', record, 'power-data', record.station_id ? `station_${record.station_id}` : null);
    res.status(201).json({ success: true, data: record });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
