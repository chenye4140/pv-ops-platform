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
  }
};

module.exports = alertService;
