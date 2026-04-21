/**
 * Enhanced Forecast Routes
 *
 * GET /api/forecast/enhanced/:stationId?date=YYYY-MM-DD&model=weighted_avg
 * GET /api/forecast/comparison/:stationId?days=3
 * GET /api/forecast/trend/:stationId
 * GET /api/forecast/summary/:stationId?date=YYYY-MM-DD
 */
const express = require('express');
const router = express.Router();
const forecastEnhancedService = require('../services/forecastEnhancedService');
const forecastService = require('../services/forecastService');
const { authenticate } = require('../middleware/authMiddleware');

router.use(authenticate);

// GET /api/forecast/enhanced/:stationId — Enhanced forecast with confidence intervals
router.get('/enhanced/:stationId', (req, res) => {
  try {
    const stationId = parseInt(req.params.stationId);
    const forecastDate = req.query.date || new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const model = req.query.model || 'weighted_avg';

    const result = forecastEnhancedService.getEnhancedForecast(stationId, forecastDate, model);
    if (!result) return res.status(404).json({ success: false, error: 'No forecast found' });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/forecast/comparison/:stationId — Compare multiple models
router.get('/comparison/:stationId', (req, res) => {
  try {
    const stationId = parseInt(req.params.stationId);
    const numDays = parseInt(req.query.days) || 3;

    const result = forecastEnhancedService.compareModels(stationId, numDays);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/forecast/trend/:stationId — 7-day trend analysis
router.get('/trend/:stationId', (req, res) => {
  try {
    const stationId = parseInt(req.params.stationId);

    const result = forecastEnhancedService.getTrendAnalysis(stationId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/forecast/summary/:stationId — Daily summary with total predicted energy
router.get('/summary/:stationId', (req, res) => {
  try {
    const stationId = parseInt(req.params.stationId);
    const date = req.query.date || null;

    const result = forecastEnhancedService.getDailySummary(stationId, date);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/forecast/aggregate?date=YYYY-MM-DD&stations=1,2,3
router.get('/aggregate', (req, res) => {
  try {
    const date = req.query.date || new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const stationIds = req.query.stations
      ? req.query.stations.split(',').map(s => parseInt(s.trim()))
      : null;

    const result = forecastEnhancedService.getAggregatedForecast(date, stationIds);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
