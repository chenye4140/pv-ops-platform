const express = require('express');
const router = express.Router();
const forecastService = require('../services/forecastService');
const forecastAutoGenerate = require('../services/forecastAutoGenerate');

// POST /api/forecast/generate/:stationId?date=YYYY-MM-DD
router.post('/generate/:stationId', (req, res) => {
  try {
    const stationId = parseInt(req.params.stationId);
    const forecastDate = req.query.date || new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const weatherForecast = req.body.weather || null;

    const result = forecastService.generateForecast(stationId, forecastDate, weatherForecast);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/forecast/all — generates forecasts for all active stations for tomorrow, returns combined results
router.get('/all', async (req, res) => {
  try {
    const forecastDate = req.query.date || null;
    const result = await forecastAutoGenerate.generateForecastsForAllStations(forecastDate);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/forecast/:stationId/compare — forecast-vs-actual accuracy analysis
router.get('/:stationId/compare', (req, res) => {
  try {
    const stationId = parseInt(req.params.stationId);
    const forecastDate = req.query.date || new Date(Date.now() - 86400000).toISOString().split('T')[0];

    const result = forecastService.getForecastAccuracy(stationId, forecastDate);
    if (result.error) return res.status(404).json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/forecast/:stationId?date=YYYY-MM-DD
router.get('/:stationId', (req, res) => {
  try {
    const stationId = parseInt(req.params.stationId);
    const forecastDate = req.query.date || new Date().toISOString().split('T')[0];

    const result = forecastService.getForecast(stationId, forecastDate);
    if (!result) return res.status(404).json({ success: false, error: 'No forecast found' });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/forecast/:stationId/accuracy?date=YYYY-MM-DD
router.get('/:stationId/accuracy', (req, res) => {
  try {
    const stationId = parseInt(req.params.stationId);
    const forecastDate = req.query.date || new Date().toISOString().split('T')[0];

    const result = forecastService.getForecastAccuracy(stationId, forecastDate);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
