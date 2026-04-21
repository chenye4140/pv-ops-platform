const { db } = require('../models/database');

const weatherService = {
  getByStationId(stationId, startTime, endTime) {
    let sql = `
      SELECT * FROM weather_data
      WHERE station_id = ?
    `;
    const params = [stationId];

    if (startTime) {
      sql += ' AND timestamp >= ?';
      params.push(startTime);
    }
    if (endTime) {
      sql += ' AND timestamp <= ?';
      params.push(endTime);
    }

    sql += ' ORDER BY timestamp ASC';

    const stmt = db.prepare(sql);
    return stmt.all(...params);
  },

  getLatest(stationId) {
    const stmt = db.prepare(`
      SELECT * FROM weather_data
      WHERE station_id = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    return stmt.get(stationId);
  }
};

module.exports = weatherService;
