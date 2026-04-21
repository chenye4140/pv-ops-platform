const express = require('express');
const router = express.Router();
const stationService = require('../services/stationService');
const inverterService = require('../services/inverterService');

// GET /api/stations
router.get('/', (req, res) => {
  try {
    const stations = stationService.getAll();
    res.json({ success: true, data: stations });
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

// GET /api/stations/:id/overview
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

// GET /api/stations/:id/inverters
router.get('/:id/inverters', (req, res) => {
  try {
    const inverters = inverterService.getByStationId(req.params.id);
    res.json({ success: true, data: inverters });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/stations/:id/inverters/:invId/strings
router.get('/:id/inverters/:invId/strings', (req, res) => {
  try {
    const strings = inverterService.getStringsByInverterId(req.params.invId);
    res.json({ success: true, data: strings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
