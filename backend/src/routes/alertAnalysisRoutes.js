const express = require('express');
const router = express.Router();
const alertAnalysisService = require('../services/alertAnalysisService');
const alertService = require('../services/alertService');
const auditService = require('../services/auditService');
const { authenticate, requireStationAccess } = require('../middleware/authMiddleware');

// Helper to extract user ID from authenticated request
function getUserId(req) {
  return req.user && req.user.userId ? req.user.userId : null;
}

router.use(authenticate);
router.use(requireStationAccess);

/**
 * GET /api/alert-analysis/:stationId
 * 智能分析当前活跃告警
 *
 * @param {number} stationId - 电站 ID（必须为数字）
 * @returns {Object} { success: true, data: { station, alert_count, event_groups, root_causes, severity_reassessment, recommended_actions, summary } }
 */
router.get('/:stationId', async (req, res) => {
  try {
    const stationId = Number(req.params.stationId);
    if (!Number.isInteger(stationId) || stationId <= 0) {
      return res.status(400).json({ success: false, error: 'stationId 必须为正整数' });
    }

    const result = await alertAnalysisService.analyzeActiveAlerts(stationId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/alert-analysis/:stationId/trend
 * 告警趋势分析
 *
 * @param {number} stationId - 电站 ID（必须为数字）
 * @param {number} [days=7] - 分析天数（query 参数，默认 7）
 * @returns {Object} { success: true, data: { station, trend, peak_hours, severity_trend, type_distribution } }
 */
router.get('/:stationId/trend', async (req, res) => {
  try {
    const stationId = Number(req.params.stationId);
    if (!Number.isInteger(stationId) || stationId <= 0) {
      return res.status(400).json({ success: false, error: 'stationId 必须为正整数' });
    }

    const days = req.query.days ? Number(req.query.days) : 7;
    if (!Number.isInteger(days) || days <= 0) {
      return res.status(400).json({ success: false, error: 'days 必须为正整数' });
    }

    const result = await alertAnalysisService.analyzeAlertTrend(stationId, days);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/alert-analysis/root-cause/:alertId
 * 单个告警根因分析
 *
 * @param {number} alertId - 告警 ID（必须为数字）
 * @returns {Object} { success: true, data: { alert, root_cause, confidence, contributing_factors, suggested_actions, related_alerts } }
 */
router.get('/root-cause/:alertId', async (req, res) => {
  try {
    const alertId = Number(req.params.alertId);
    if (!Number.isInteger(alertId) || alertId <= 0) {
      return res.status(400).json({ success: false, error: 'alertId 必须为正整数' });
    }

    const result = await alertAnalysisService.getAlertRootCause(alertId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/alert-analysis/batch
 * 批量分析告警
 *
 * @param {number[]} alertIds - 告警 ID 数组
 * @returns {Object} { success: true, data: { results: [...], summary: { total, success, failed } } }
 */
router.post('/batch', async (req, res) => {
  try {
    const { alertIds } = req.body;

    if (!Array.isArray(alertIds) || alertIds.length === 0) {
      return res.status(400).json({ success: false, error: 'alertIds 必须为非空数组' });
    }

    // 校验所有 ID 为正整数
    for (const id of alertIds) {
      if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
        return res.status(400).json({ success: false, error: 'alertIds 中的每个元素必须为正整数' });
      }
    }

    const result = await alertAnalysisService.batchAnalyzeAlerts(alertIds);
    auditService.logAction(getUserId(req), 'batch_analyze', 'alert_analysis', null, { alert_count: alertIds.length, results: result.summary }, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
