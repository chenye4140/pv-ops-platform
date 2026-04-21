const express = require('express');
const router = express.Router();
const alertService = require('../services/alertService');

// GET /api/alerts?stationId=&status=
router.get('/', (req, res) => {
  try {
    const { stationId, status } = req.query;
    const alerts = alertService.getAll(stationId, status);
    res.json({ success: true, data: alerts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
