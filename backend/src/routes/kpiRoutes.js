const express = require('express');
const router = express.Router();
const kpiService = require('../services/kpiService');
const { authenticate, requireStationAccess } = require('../middleware/authMiddleware');

router.use(authenticate);
router.use(requireStationAccess);

// GET /api/kpi/dashboard/:stationId — combined KPI data for a station
router.get('/dashboard/:stationId', (req, res) => {
  try {
    const kpi = kpiService.getDashboardKPI(req.params.stationId);
    if (!kpi) {
      return res.status(404).json({ success: false, error: 'Station not found' });
    }
    res.json({ success: true, data: kpi });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/kpi/all-stations — PR + key metrics for ALL stations
router.get('/all-stations', (req, res) => {
  try {
    const stations = kpiService.getAllStationsKPI();
    res.json({ success: true, data: stations });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/kpi/alert-severity?stationId=X — alert severity breakdown
router.get('/alert-severity', (req, res) => {
  try {
    const { stationId } = req.query;
    const breakdown = kpiService.getAlertSeverityBreakdown(stationId || null);
    res.json({ success: true, data: breakdown });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/kpi/pr/:stationId — standalone PR calculation
router.get('/pr/:stationId', (req, res) => {
  try {
    const dateStr = req.query.date || new Date().toISOString();
    const pr = kpiService.calculatePR(req.params.stationId, dateStr);
    if (!pr) {
      return res.status(404).json({ success: false, error: 'Station not found' });
    }
    res.json({ success: true, data: pr });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/kpi/dod/:stationId/:metric — day-over-day comparison
router.get('/dod/:stationId/:metric', (req, res) => {
  try {
    const validMetrics = ['energy', 'pr', 'revenue', 'availability'];
    if (!validMetrics.includes(req.params.metric)) {
      return res.status(400).json({
        success: false,
        error: `Invalid metric. Must be one of: ${validMetrics.join(', ')}`,
      });
    }
    const dod = kpiService.getDayOverDay(req.params.stationId, req.params.metric);
    res.json({ success: true, data: dod });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/kpi/trend/all — 7-day KPI trend aggregated across ALL stations
router.get('/trend/all', (req, res) => {
  try {
    const trend = kpiService.getAll7DayTrend();
    res.json({ success: true, data: trend });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/kpi/trend/:stationId — 7-day KPI trend (PR, energy, revenue, availability)
router.get('/trend/:stationId', (req, res) => {
  try {
    const trend = kpiService.get7DayTrend(req.params.stationId);
    if (!trend) {
      return res.status(404).json({ success: false, error: 'Station not found' });
    }
    res.json({ success: true, data: trend });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
