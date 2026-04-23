const express = require('express');
const router = express.Router();
const { db } = require('../models/database');
const { generateDailyReportSummary, isConfigured } = require('../services/aiService');
const reportGenerationService = require('../services/reportGenerationService');
const { authenticate, requireRole } = require('../middleware/authMiddleware');
const auditService = require('../services/auditService');

function getUserId(req) {
  return req.user ? req.user.id : null;
}

router.use(authenticate);

// ============================================================================
// Legacy daily report endpoint (backward compatible)
// ============================================================================

// GET /api/reports/daily/:stationId
// Generates a daily report preview for the specified station (legacy format)
router.get('/daily/:stationId', async (req, res) => {
  try {
    const stationId = req.params.stationId;
    const date = req.query.date; // optional YYYY-MM-DD

    // Use enhanced report generation service
    const report = await reportGenerationService.generateDailyReport(stationId, date);

    if (!report.success) {
      return res.status(404).json({ success: false, error: report.error || 'Report generation failed' });
    }

    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// Enhanced AI report generation endpoints
// ============================================================================

// GET /api/reports/enhanced/daily/:stationId
// Enhanced daily report with full AI generation
router.get('/enhanced/daily/:stationId', async (req, res) => {
  try {
    const stationId = req.params.stationId;
    const date = req.query.date;

    const report = await reportGenerationService.generateDailyReport(stationId, date);

    if (!report.success) {
      return res.status(404).json({ success: false, error: report.error || 'Report generation failed' });
    }

    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/enhanced/weekly/:stationId
// Weekly report covering the last 7 days
// Query params: endDate (YYYY-MM-DD, optional, defaults to today)
router.get('/enhanced/weekly/:stationId', async (req, res) => {
  try {
    const stationId = req.params.stationId;
    const endDate = req.query.endDate;

    const report = await reportGenerationService.generateWeeklyReport(stationId, endDate);

    if (!report.success) {
      return res.status(404).json({ success: false, error: report.error || 'Report generation failed' });
    }

    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/enhanced/monthly/:stationId
// Monthly report
// Query params: year (number, optional), month (number 1-12, optional)
router.get('/enhanced/monthly/:stationId', async (req, res) => {
  try {
    const stationId = req.params.stationId;
    const year = req.query.year ? parseInt(req.query.year, 10) : undefined;
    const month = req.query.month ? parseInt(req.query.month, 10) : undefined;

    const report = await reportGenerationService.generateMonthlyReport(stationId, year, month);

    if (!report.success) {
      return res.status(404).json({ success: false, error: report.error || 'Report generation failed' });
    }

    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/enhanced/special/:stationId
// Special-purpose report (anomaly / maintenance / comparison)
// Query params: type (anomaly|maintenance|comparison, required),
//               days (number, optional, default 7),
//               startDate (YYYY-MM-DD, optional),
//               endDate (YYYY-MM-DD, optional)
router.get('/enhanced/special/:stationId', async (req, res) => {
  try {
    const stationId = req.params.stationId;
    const { type, days, startDate, endDate } = req.query;

    if (!type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameter: type (anomaly|maintenance|comparison)',
      });
    }

    const params = {};
    if (days) params.days = parseInt(days, 10);
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;

    const report = await reportGenerationService.generateSpecialReport(stationId, type, params);

    if (!report.success) {
      return res.status(404).json({ success: false, error: report.error || 'Report generation failed' });
    }

    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// POST endpoints for async report generation (for larger reports)
// ============================================================================

// POST /api/reports/generate/daily
// Body: { stationId, date? }
router.post('/generate/daily', requireRole('admin', 'manager', 'operator'), async (req, res) => {
  try {
    const { stationId, date } = req.body;
    if (!stationId) {
      return res.status(400).json({ success: false, error: 'stationId is required' });
    }

    const report = await reportGenerationService.generateDailyReport(stationId, date);

    if (!report.success) {
      return res.status(404).json({ success: false, error: report.error || 'Report generation failed' });
    }

    auditService.logAction(getUserId(req), 'generate', 'report', null, { type: 'daily', station_id: stationId, date }, req.ip);
    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/reports/generate/weekly
// Body: { stationId, endDate? }
router.post('/generate/weekly', requireRole('admin', 'manager', 'operator'), async (req, res) => {
  try {
    const { stationId, endDate } = req.body;
    if (!stationId) {
      return res.status(400).json({ success: false, error: 'stationId is required' });
    }

    const report = await reportGenerationService.generateWeeklyReport(stationId, endDate);

    if (!report.success) {
      return res.status(404).json({ success: false, error: report.error || 'Report generation failed' });
    }

    auditService.logAction(getUserId(req), 'generate', 'report', null, { type: 'weekly', station_id: stationId, end_date: endDate }, req.ip);
    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/reports/generate/monthly
// Body: { stationId, year?, month? }
router.post('/generate/monthly', requireRole('admin', 'manager', 'operator'), async (req, res) => {
  try {
    const { stationId, year, month } = req.body;
    if (!stationId) {
      return res.status(400).json({ success: false, error: 'stationId is required' });
    }

    const report = await reportGenerationService.generateMonthlyReport(stationId, year, month);

    if (!report.success) {
      return res.status(404).json({ success: false, error: report.error || 'Report generation failed' });
    }

    auditService.logAction(getUserId(req), 'generate', 'report', null, { type: 'monthly', station_id: stationId, year, month }, req.ip);
    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/reports/generate/special
// Body: { stationId, reportType, params? }
router.post('/generate/special', requireRole('admin', 'manager', 'operator'), async (req, res) => {
  try {
    const { stationId, reportType, params } = req.body;
    if (!stationId) {
      return res.status(400).json({ success: false, error: 'stationId is required' });
    }
    if (!reportType) {
      return res.status(400).json({
        success: false,
        error: 'reportType is required (anomaly|maintenance|comparison)',
      });
    }

    const report = await reportGenerationService.generateSpecialReport(stationId, reportType, params || {});

    if (!report.success) {
      return res.status(404).json({ success: false, error: report.error || 'Report generation failed' });
    }

    auditService.logAction(getUserId(req), 'generate', 'report', null, { type: reportType, station_id: stationId, params }, req.ip);
    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
