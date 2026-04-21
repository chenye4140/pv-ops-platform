const express = require('express');
const router = express.Router();
const stationService = require('../services/stationService');
const inverterService = require('../services/inverterService');
const alertService = require('../services/alertService');

// GET /api/stations
router.get('/', (req, res) => {
  try {
    const stations = stationService.getAll();
    res.json({ success: true, data: stations });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/stations/:id/overview  (MUST be before /:id)
router.get('/:id/overview', (req, res) => {
  try {
    const overview = stationService.getOverview(req.params.id);
    if (!overview) {
      return res.status(404).json({ success: false, error: 'Station not found' });
    }
    res.json({ success: true, data: overview });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/stations/:id/inverters/:invId/strings  (MUST be before /:id/inverters)
router.get('/:id/inverters/:invId/strings', (req, res) => {
  try {
    const strings = inverterService.getStringsByInverterId(req.params.invId);
    res.json({ success: true, data: strings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/stations/:id/inverters  (MUST be before /:id)
router.get('/:id/inverters', (req, res) => {
  try {
    const inverters = inverterService.getByStationId(req.params.id);
    res.json({ success: true, data: inverters });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/stations/:id
router.get('/:id', (req, res) => {
  try {
    const station = stationService.getById(req.params.id);
    if (!station) {
      return res.status(404).json({ success: false, error: 'Station not found' });
    }
    res.json({ success: true, data: station });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/stations/:id/alerts  (MUST be before /:id)
router.get('/:id/alerts', (req, res) => {
  try {
    const { status } = req.query;
    const alerts = alertService.getAll(req.params.id, status);
    res.json({ success: true, data: alerts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/stations/:id/alerts/:aid/ack  (MUST be before /:id)
router.post('/:id/alerts/:aid/ack', (req, res) => {
  try {
    const result = alertService.acknowledge(req.params.aid);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/stations/:id/weather  (MUST be before /:id)
router.get('/:id/weather', (req, res) => {
  try {
    const { start, startTime, end, endTime } = req.query;
    const weatherService = require('../services/weatherService');
    const data = weatherService.getByStationId(req.params.id, startTime || start, endTime || end);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
