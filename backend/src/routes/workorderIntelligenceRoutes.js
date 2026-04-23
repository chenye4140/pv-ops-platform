const express = require('express');
const router = express.Router();
const workorderIntelligenceService = require('../services/workorderIntelligenceService');
const auditService = require('../services/auditService');
const { authenticate, requireStationAccess } = require('../middleware/authMiddleware');

// Helper to extract user ID from authenticated request
function getUserId(req) {
  return req.user && req.user.userId ? req.user.userId : null;
}

router.use(authenticate);
router.use(requireStationAccess);

/**
 * POST /api/workorder-intelligence/:workorderId/classify
 * 智能工单分类
 *
 * @param {number} workorderId - 工单 ID（必须为正整数）
 * @returns {Object} { success: true, data: { workOrderId, currentType, suggestedType, confidence, reasoning, needCorrection, model, fallback } }
 */
router.post('/:workorderId/classify', async (req, res) => {
  try {
    const workorderId = Number(req.params.workorderId);
    if (!Number.isInteger(workorderId) || workorderId <= 0) {
      return res.status(400).json({ success: false, error: 'workorderId 必须为正整数' });
    }

    const result = await workorderIntelligenceService.classifyWorkorder(workorderId);
    auditService.logAction(getUserId(req), 'classify', 'workorder_intelligence', workorderId, { suggestedType: result.suggestedType, confidence: result.confidence }, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/workorder-intelligence/:workorderId/recommend-assignee
 * 智能派单推荐
 *
 * @param {number} workorderId - 工单 ID（必须为正整数）
 * @returns {Object} { success: true, data: { recommendedPerson, reason, availableParts, estimatedTime, requiredSkills, alternativePerson, model, fallback } }
 */
router.post('/:workorderId/recommend-assignee', async (req, res) => {
  try {
    const workorderId = Number(req.params.workorderId);
    if (!Number.isInteger(workorderId) || workorderId <= 0) {
      return res.status(400).json({ success: false, error: 'workorderId 必须为正整数' });
    }

    const result = await workorderIntelligenceService.recommendAssignee(workorderId);
    auditService.logAction(getUserId(req), 'recommend_assignee', 'workorder_intelligence', workorderId, { recommendedPerson: result.recommendedPerson }, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/workorder-intelligence/:workorderId/recommend-solution
 * 智能方案推荐
 *
 * @param {number} workorderId - 工单 ID（必须为正整数）
 * @returns {Object} { success: true, data: { steps, requiredParts, estimatedDuration, precautions, similarCases, rootCause, tools, model, fallback } }
 */
router.post('/:workorderId/recommend-solution', async (req, res) => {
  try {
    const workorderId = Number(req.params.workorderId);
    if (!Number.isInteger(workorderId) || workorderId <= 0) {
      return res.status(400).json({ success: false, error: 'workorderId 必须为正整数' });
    }

    const result = await workorderIntelligenceService.recommendSolution(workorderId);
    auditService.logAction(getUserId(req), 'recommend_solution', 'workorder_intelligence', workorderId, { stepCount: result.steps?.length || 0 }, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/workorder-intelligence/:workorderId/completion-report
 * 智能完工报告生成
 *
 * @param {number} workorderId - 工单 ID（必须为正整数）
 * @returns {Object} { success: true, data: { summary, actionsTaken, partsUsed, recommendations, followUpNeeded, followUpActions, lessonsLearned, model, fallback } }
 */
router.post('/:workorderId/completion-report', async (req, res) => {
  try {
    const workorderId = Number(req.params.workorderId);
    if (!Number.isInteger(workorderId) || workorderId <= 0) {
      return res.status(400).json({ success: false, error: 'workorderId 必须为正整数' });
    }

    const result = await workorderIntelligenceService.generateCompletionReport(workorderId);
    auditService.logAction(getUserId(req), 'completion_report', 'workorder_intelligence', workorderId, { followUpNeeded: result.followUpNeeded }, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/workorder-intelligence/:stationId/trends
 * 工单趋势分析
 *
 * @param {number} stationId - 电站 ID（必须为正整数）
 * @param {number} [days=30] - 分析天数（query 参数，默认 30）
 * @returns {Object} { success: true, data: { statistics, patterns, recommendations, summary, model, fallback } }
 */
router.get('/:stationId/trends', async (req, res) => {
  try {
    const stationId = Number(req.params.stationId);
    if (!Number.isInteger(stationId) || stationId <= 0) {
      return res.status(400).json({ success: false, error: 'stationId 必须为正整数' });
    }

    const days = req.query.days ? Number(req.query.days) : 30;
    if (!Number.isInteger(days) || days <= 0) {
      return res.status(400).json({ success: false, error: 'days 必须为正整数' });
    }

    const result = await workorderIntelligenceService.analyzeWorkorderTrends(stationId, days);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
