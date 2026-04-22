const express = require('express');
const router = express.Router();
const alertRuleService = require('../services/alertRuleService');
const auditService = require('../services/auditService');
const { db } = require('../models/database');
const { authenticate, requireRole, requireStationAccess } = require('../middleware/authMiddleware');

router.use(authenticate);
router.use(requireStationAccess);

function getUserId(req) {
  return req.user ? req.user.id : null;
}

// GET /api/alert-rules?station_id=&type=&enabled=
router.get('/', (req, res) => {
  try {
    const { station_id, type, enabled } = req.query;
    const filters = {};
    if (station_id !== undefined) filters.station_id = station_id === 'null' ? null : parseInt(station_id);
    if (type) filters.type = type;
    if (enabled !== undefined) filters.enabled = enabled === 'true';

    const rules = alertRuleService.getAll(filters);
    res.json({ success: true, data: rules });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/alert-rules/stats
router.get('/stats', (req, res) => {
  try {
    const stats = alertRuleService.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/alert-rules/evaluations/recent?station_id=&limit=100
router.get('/evaluations/recent', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const stationId = req.query.station_id ? parseInt(req.query.station_id) : null;

    let query = `
      SELECT e.*, ar.name as rule_name, ar.type as rule_type, ar.threshold as rule_threshold,
             s.name as station_name
      FROM alert_rule_evaluations e
      LEFT JOIN alert_rules ar ON e.rule_id = ar.id
      LEFT JOIN stations s ON e.station_id = s.id
    `;
    const params = [];
    if (stationId) {
      query += ' WHERE e.station_id = ?';
      params.push(stationId);
    }
    query += ' ORDER BY e.evaluated_at DESC LIMIT ?';
    params.push(limit);

    const evaluations = db.prepare(query).all(...params);
    res.json({ success: true, data: evaluations });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/alert-rules/:id
router.get('/:id', (req, res) => {
  try {
    const rule = alertRuleService.getById(req.params.id);
    if (!rule) return res.status(404).json({ success: false, error: '规则不存在' });
    res.json({ success: true, data: rule });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/alert-rules/:id/evaluations?limit=50
router.get('/:id/evaluations', (req, res) => {
  try {
    const rule = alertRuleService.getById(req.params.id);
    if (!rule) return res.status(404).json({ success: false, error: '规则不存在' });

    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const evaluations = db.prepare(`
      SELECT e.*, s.name as station_name
      FROM alert_rule_evaluations e
      LEFT JOIN stations s ON e.station_id = s.id
      WHERE e.rule_id = ?
      ORDER BY e.evaluated_at DESC
      LIMIT ?
    `).all(req.params.id, limit);

    res.json({ success: true, data: evaluations });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/alert-rules
router.post('/', requireRole('admin', 'manager'), (req, res) => {
  try {
    const rule = alertRuleService.create(req.body);
    auditService.logAction(getUserId(req), 'create', 'alert_rule', rule.id, { name: rule.name, type: rule.type, station_id: rule.station_id }, req.ip);
    res.status(201).json({ success: true, data: rule });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// PUT /api/alert-rules/:id
router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  try {
    const rule = alertRuleService.update(req.params.id, req.body);
    auditService.logAction(getUserId(req), 'update', 'alert_rule', rule.id, { fields: Object.keys(req.body) }, req.ip);
    res.json({ success: true, data: rule });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(400).json({ success: false, error: error.message });
  }
});

// DELETE /api/alert-rules/:id
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  try {
    const result = alertRuleService.delete(req.params.id);
    auditService.logAction(getUserId(req), 'delete', 'alert_rule', req.params.id, { name: result.name }, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

// POST /api/alert-rules/:id/evaluate
router.post('/:id/evaluate', requireRole('admin', 'manager'), (req, res) => {
  try {
    const rule = alertRuleService.getById(req.params.id);
    if (!rule) return res.status(404).json({ success: false, error: '规则不存在' });

    const stationId = rule.station_id || req.body.station_id;
    if (!stationId) return res.status(400).json({ success: false, error: 'station_id required' });

    const result = alertRuleService.evaluateRule(rule, stationId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/alert-rules/evaluate-all/:stationId
router.post('/evaluate-all/:stationId', requireRole('admin', 'manager'), (req, res) => {
  try {
    const stationId = parseInt(req.params.stationId);
    const result = alertRuleService.runEvaluation(stationId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/alert-rules/seed/:stationId
router.post('/seed/:stationId', requireRole('admin', 'manager'), (req, res) => {
  try {
    const stationId = parseInt(req.params.stationId);
    const rules = alertRuleService.seedDefaults(stationId);
    auditService.logAction(getUserId(req), 'seed', 'alert_rule', null, { station_id: stationId, count: rules.length }, req.ip);
    res.json({ success: true, data: rules, count: rules.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
