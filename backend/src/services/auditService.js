const { db } = require('../models/database');

function logAction(userId, action, resource, resourceId, details, ipAddress) {
  const detailsJson = details ? JSON.stringify(details) : null;
  db.prepare(`
    INSERT INTO audit_logs (user_id, action, resource, resource_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, action, resource || null, resourceId || null, detailsJson, ipAddress || null);
}

function getAuditLogs({ userId, action, resource, startDate, endDate, limit, offset } = {}) {
  const conditions = [];
  const values = [];

  if (userId) {
    conditions.push('al.user_id = ?');
    values.push(userId);
  }
  if (action) {
    conditions.push('al.action = ?');
    values.push(action);
  }
  if (resource) {
    conditions.push('al.resource = ?');
    values.push(resource);
  }
  if (startDate) {
    conditions.push('al.created_at >= ?');
    values.push(startDate);
  }
  if (endDate) {
    conditions.push('al.created_at <= ?');
    values.push(endDate);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const limitVal = limit || 100;
  const offsetVal = offset || 0;

  const logs = db.prepare(`
    SELECT al.*, u.username, u.display_name
    FROM audit_logs al
    LEFT JOIN users u ON al.user_id = u.id
    ${whereClause}
    ORDER BY al.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...values, limitVal, offsetVal);

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM audit_logs al ${whereClause}
  `).get(...values);

  // Parse details JSON
  const parsedLogs = logs.map((log) => {
    if (log.details) {
      try {
        log.details = JSON.parse(log.details);
      } catch {
        // Keep as string if not valid JSON
      }
    }
    return log;
  });

  return {
    logs: parsedLogs,
    total: total.count,
    limit: limitVal,
    offset: offsetVal,
  };
}

function getAuditStats() {
  // Actions per day (last 7 days)
  const actionsPerDay = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as count
    FROM audit_logs
    WHERE created_at >= datetime('now', '-7 days')
    GROUP BY DATE(created_at)
    ORDER BY date DESC
  `).all();

  // Top users by action count
  const topUsers = db.prepare(`
    SELECT u.username, u.display_name, u.role, COUNT(*) as action_count
    FROM audit_logs al
    JOIN users u ON al.user_id = u.id
    GROUP BY al.user_id
    ORDER BY action_count DESC
    LIMIT 10
  `).all();

  // Action type distribution
  const actionDistribution = db.prepare(`
    SELECT action, COUNT(*) as count
    FROM audit_logs
    GROUP BY action
    ORDER BY count DESC
  `).all();

  // Resource distribution
  const resourceDistribution = db.prepare(`
    SELECT resource, COUNT(*) as count
    FROM audit_logs
    WHERE resource IS NOT NULL
    GROUP BY resource
    ORDER BY count DESC
  `).all();

  // Total log count
  const totalCount = db.prepare('SELECT COUNT(*) as count FROM audit_logs').get();

  // Recent activity (last 24 hours)
  const last24h = db.prepare(`
    SELECT COUNT(*) as count FROM audit_logs
    WHERE created_at >= datetime('now', '-24 hours')
  `).get();

  return {
    totalLogs: totalCount.count,
    last24Hours: last24h.count,
    actionsPerDay,
    topUsers,
    actionDistribution,
    resourceDistribution,
  };
}

module.exports = {
  logAction,
  getAuditLogs,
  getAuditStats,
};
