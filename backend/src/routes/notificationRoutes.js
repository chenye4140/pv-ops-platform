const express = require('express');
const router = express.Router();
const { db } = require('../models/database');
const notificationService = require('../services/notificationService');
const { authenticate } = require('../middleware/authMiddleware');

router.use(authenticate);

// GET /api/notifications — Get user's notifications
router.get('/', (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const { type, severity, is_read } = req.query;

    const notifications = notificationService.getByUserId(userId, {
      limit,
      offset,
      type,
      severity,
      is_read: is_read !== undefined ? is_read === 'true' : undefined,
    });

    const unreadCount = notificationService.getUnreadCount(userId);

    res.json({
      success: true,
      data: {
        notifications,
        unread_count: unreadCount,
        total: notifications.length,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/notifications/unread-count — Get unread notification count
router.get('/unread-count', (req, res) => {
  try {
    const count = notificationService.getUnreadCount(req.user.id);
    res.json({ success: true, data: { count } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/notifications/:id/read — Mark notification as read
router.put('/:id/read', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const changed = notificationService.markAsRead(id, req.user.id);
    if (changed === 0) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }
    res.json({ success: true, data: { marked: changed } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/notifications/read-all — Mark all as read
router.put('/read-all', (req, res) => {
  try {
    const changed = notificationService.markAllAsRead(req.user.id);
    res.json({ success: true, data: { marked: changed } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/notifications/:id — Delete a notification
router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const deleted = notificationService.delete(id, req.user.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/notifications/stats — Get notification statistics
router.get('/stats', (req, res) => {
  try {
    const userId = req.user.id;

    const byType = db.prepare(`
      SELECT type, COUNT(*) as count
      FROM notifications
      WHERE (user_id = ? OR user_id IS NULL)
      GROUP BY type
    `).all(userId);

    const bySeverity = db.prepare(`
      SELECT severity, COUNT(*) as count
      FROM notifications
      WHERE (user_id = ? OR user_id IS NULL) AND is_read = 0
      GROUP BY severity
    `).all(userId);

    const recentCount = db.prepare(`
      SELECT COUNT(*) as count FROM notifications
      WHERE (user_id = ? OR user_id IS NULL)
      AND created_at >= datetime('now', '-24 hours')
    `).get(userId);

    res.json({
      success: true,
      data: {
        by_type: Object.fromEntries(byType.map(r => [r.type, r.count])),
        by_severity: Object.fromEntries(bySeverity.map(r => [r.severity, r.count])),
        last_24h: recentCount.count,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
