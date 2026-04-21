const express = require('express');
const router = express.Router();
const auditService = require('../services/auditService');
const { authenticate, requireRole } = require('../middleware/authMiddleware');

// All audit routes require admin authentication
router.use(authenticate);
router.use(requireRole('admin'));

// GET /api/audit/logs - list audit logs with filters
router.get('/logs', (req, res) => {
  try {
    const { userId, action, resource, startDate, endDate, limit, offset } = req.query;
    const result = auditService.getAuditLogs({
      userId: userId ? parseInt(userId, 10) : undefined,
      action,
      resource,
      startDate,
      endDate,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/audit/stats - get audit statistics
router.get('/stats', (req, res) => {
  try {
    const stats = auditService.getAuditStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
