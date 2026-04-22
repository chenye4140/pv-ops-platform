/**
 * Notification Service — system-wide notification management.
 *
 * Supports:
 *   - Broadcast notifications to all users
 *   - User-specific notifications
 *   - Link to resources (alerts, work orders, inspections)
 *   - Read/unread tracking
 */

const { db } = require('../models/database');

const notificationService = {

  /**
   * Create a new notification.
   * @param {object} params
   * @param {number|null} params.user_id - Target user (null = broadcast)
   * @param {string} params.title
   * @param {string} params.message
   * @param {string} [params.type='info'] - 'alert' | 'workorder' | 'inspection' | 'system' | 'info'
   * @param {string} [params.severity='info'] - 'critical' | 'warning' | 'info' | 'success'
   * @param {string} [params.resource_type] - Resource type link
   * @param {number} [params.resource_id] - Resource ID link
   * @param {number} [params.station_id] - Station ID link
   * @returns {object} Created notification
   */
  create({ user_id = null, title, message, type = 'info', severity = 'info', resource_type = null, resource_id = null, station_id = null }) {
    const result = db.prepare(`
      INSERT INTO notifications (user_id, title, message, type, severity, resource_type, resource_id, station_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user_id, title, message, type, severity, resource_type, resource_id, station_id);

    return {
      id: result.lastInsertRowid,
      user_id,
      title,
      message,
      type,
      severity,
      is_read: 0,
      resource_type,
      resource_id,
      station_id,
    };
  },

  /**
   * Get notifications for a user (includes broadcast notifications where user_id IS NULL).
   * @param {number} userId
   * @param {object} options - { limit, offset, type, severity, is_read }
   * @returns {Array}
   */
  getByUserId(userId, options = {}) {
    const { limit = 50, offset = 0, type, severity, is_read } = options;

    let sql = `
      SELECT n.*, s.name as station_name
      FROM notifications n
      LEFT JOIN stations s ON n.station_id = s.id
      WHERE n.user_id = ? OR n.user_id IS NULL
    `;
    const params = [userId];

    if (type) {
      sql += ' AND n.type = ?';
      params.push(type);
    }
    if (severity) {
      sql += ' AND n.severity = ?';
      params.push(severity);
    }
    if (is_read !== undefined) {
      sql += ' AND n.is_read = ?';
      params.push(is_read ? 1 : 0);
    }

    sql += ' ORDER BY n.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return db.prepare(sql).all(...params);
  },

  /**
   * Get unread count for a user.
   * @param {number} userId
   * @returns {number}
   */
  getUnreadCount(userId) {
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM notifications
      WHERE (user_id = ? OR user_id IS NULL) AND is_read = 0
    `).get(userId);
    return result.count;
  },

  /**
   * Mark notification(s) as read.
   * @param {number|number[]} ids - Single ID or array of IDs
   * @param {number} userId
   * @returns {number} Number of rows updated
   */
  markAsRead(ids, userId) {
    const idArray = Array.isArray(ids) ? ids : [ids];
    const placeholders = idArray.map(() => '?').join(',');
    const sql = `UPDATE notifications SET is_read = 1 WHERE id IN (${placeholders}) AND (user_id = ? OR user_id IS NULL)`;
    const result = db.prepare(sql).run(...idArray, userId);
    return result.changes;
  },

  /**
   * Mark all notifications as read for a user.
   * @param {number} userId
   * @returns {number} Number of rows updated
   */
  markAllAsRead(userId) {
    const result = db.prepare(`
      UPDATE notifications SET is_read = 1
      WHERE (user_id = ? OR user_id IS NULL) AND is_read = 0
    `).run(userId);
    return result.changes;
  },

  /**
   * Delete a notification.
   * @param {number} id
   * @param {number} userId
   * @returns {boolean}
   */
  delete(id, userId) {
    const result = db.prepare(`
      DELETE FROM notifications WHERE id = ? AND (user_id = ? OR user_id IS NULL)
    `).run(id, userId);
    return result.changes > 0;
  },

  /**
   * Auto-create notification from alert event.
   * @param {object} alert - Alert data
   */
  fromAlert(alert) {
    return this.create({
      title: `告警: ${alert.type}`,
      message: alert.message,
      type: 'alert',
      severity: alert.severity,
      resource_type: 'alert',
      resource_id: alert.id,
      station_id: alert.station_id,
    });
  },

  /**
   * Auto-create notification from work order event.
   * @param {object} workorder - Work order data
   * @param {string} action - 'created' | 'updated' | 'completed'
   */
  fromWorkorder(workorder, action = 'created') {
    const actionLabels = { created: '新建', updated: '更新', completed: '完成', deleted: '删除' };
    return this.create({
      title: `工单${actionLabels[action] || action}: ${workorder.title}`,
      message: workorder.description || '',
      type: 'workorder',
      severity: workorder.priority === 'high' ? 'warning' : 'info',
      resource_type: 'workorder',
      resource_id: workorder.id,
      station_id: workorder.station_id,
    });
  },

  /**
   * Auto-create notification from inspection event.
   * @param {object} inspection - Inspection data
   * @param {string} action - 'created' | 'completed'
   */
  fromInspection(inspection, action = 'created') {
    const actionLabels = { created: '新建', completed: '完成', overdue: '逾期' };
    return this.create({
      title: `巡检${actionLabels[action] || action}: ${inspection.title}`,
      message: inspection.description || '',
      type: 'inspection',
      severity: 'info',
      resource_type: 'inspection',
      resource_id: inspection.id,
      station_id: inspection.station_id,
    });
  },

  /**
   * Clean up old notifications (older than N days).
   * @param {number} days - Days to keep
   * @returns {number} Number of deleted rows
   */
  cleanupOld(days = 30) {
    const result = db.prepare(`
      DELETE FROM notifications WHERE created_at < datetime('now', ?)
    `).run(`-${days} days`);
    return result.changes;
  },
};

module.exports = notificationService;
