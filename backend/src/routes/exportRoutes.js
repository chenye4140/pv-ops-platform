const express = require('express');
const router = express.Router();
const exportService = require('../services/exportService');
const { authenticate } = require('../middleware/authMiddleware');

router.use(authenticate);

// GET /api/export/power-data?station_id=&start_time=&end_time=&string_id=
router.get('/power-data', (req, res) => {
  try {
    const filters = {};
    if (req.query.station_id) filters.station_id = parseInt(req.query.station_id);
    if (req.query.start_time) filters.start_time = req.query.start_time;
    if (req.query.end_time) filters.end_time = req.query.end_time;
    if (req.query.string_id) filters.string_id = parseInt(req.query.string_id);

    const result = exportService.exportPowerData(filters);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/export/alerts?station_id=&status=&severity=&type=
router.get('/alerts', (req, res) => {
  try {
    const filters = {};
    if (req.query.station_id) filters.station_id = parseInt(req.query.station_id);
    if (req.query.status) filters.status = req.query.status;
    if (req.query.severity) filters.severity = req.query.severity;
    if (req.query.type) filters.type = req.query.type;

    const result = exportService.exportAlerts(filters);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/export/workorders?status=&priority=&assignee=&station_id=
router.get('/workorders', (req, res) => {
  try {
    const filters = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.query.priority) filters.priority = req.query.priority;
    if (req.query.assignee) filters.assignee = req.query.assignee;
    if (req.query.station_id) filters.station_id = parseInt(req.query.station_id);

    const result = exportService.exportWorkOrders(filters);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/export/station/:id
router.get('/station/:id', (req, res) => {
  try {
    const stationId = parseInt(req.params.id);
    const result = exportService.exportStationOverview(stationId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/export/inspections/:stationId
router.get('/inspections/:stationId', (req, res) => {
  try {
    const stationId = parseInt(req.params.stationId);
    const result = exportService.exportInspections(stationId);
    // Export both inspections and tasks as a combined CSV
    const combined = result.inspections.csv + '\n--- 巡检任务 ---\n' + result.tasks.csv;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(combined);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
