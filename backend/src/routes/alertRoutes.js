const express = require('express');
const router = express.Router();
const alertService = require('../services/alertService');
const wsService = require('../services/websocketService');
const auditService = require('../services/auditService');
const { authenticate, requireStationAccess } = require('../middleware/authMiddleware');

router.use(authenticate);
router.use(requireStationAccess);

function getUserId(req) {
  return req.user ? req.user.id : null;
}

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

// POST /api/alerts
router.post('/', (req, res) => {
  try {
    const alert = alertService.create(req.body);
    auditService.logAction(getUserId(req), 'create', 'alert', alert.id, { severity: alert.severity, type: alert.type, station_id: alert.station_id }, req.ip);
    // Broadcast to "alerts" topic with optional room
    wsService.broadcast('created', alert, 'alerts', alert.station_id ? `station_${alert.station_id}` : null);
    res.status(201).json({ success: true, data: alert });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
