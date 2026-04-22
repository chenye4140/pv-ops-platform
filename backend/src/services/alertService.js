const { db } = require('../models/database');

const alertService = {
  getAll(stationId, status) {
    let sql = 'SELECT * FROM alerts WHERE 1=1';
    const params = [];

    if (stationId) {
      sql += ' AND station_id = ?';
      params.push(stationId);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC';

    const stmt = db.prepare(sql);
    return stmt.all(...params);
  },

  getActiveCount(stationId) {
    const stmt = db.prepare(
      "SELECT COUNT(*) as count FROM alerts WHERE station_id = ? AND status = 'active'"
    );
    return stmt.get(stationId).count;
  },

  acknowledge(alertId) {
    const result = db.prepare(
      "UPDATE alerts SET status = 'acknowledged', acknowledged_at = datetime('now') WHERE id = ?"
    ).run(alertId);
    return { id: alertId, ...result };
  },

  getByType(stationId, type) {
    const stmt = db.prepare(
      "SELECT * FROM alerts WHERE station_id = ? AND type = ? ORDER BY created_at DESC"
    );
    return stmt.all(stationId, type);
  },

  create(data) {
    if (!data.message || !data.type || !data.station_id) {
      throw new Error('message, type, and station_id are required');
    }

    // Check for recent duplicate alerts (cooldown/deduplication)
    const existing = db.prepare(
      `SELECT * FROM alerts
       WHERE station_id = ? AND type = ? AND severity = ?
         AND status = 'active'
         AND created_at >= datetime('now', '-30 minutes')
       ORDER BY created_at DESC
       LIMIT 1`
    ).get(
      data.station_id,
      data.type,
      data.severity || 'warning'
    );

    if (existing) {
      return { ...existing, deduplicated: true };
    }

    const result = db.prepare(
      `INSERT INTO alerts (station_id, type, message, severity, status)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      data.station_id,
      data.type,
      data.message,
      data.severity || 'warning',
      data.status || 'active'
    );

    const stmt = db.prepare('SELECT * FROM alerts WHERE id = ?');
    return stmt.get(result.lastInsertRowid);
  }
};

module.exports = alertService;
