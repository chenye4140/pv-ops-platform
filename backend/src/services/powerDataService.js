const { db } = require('../models/database');

const powerDataService = {
  getByStringId(stringId, startTime, endTime) {
    let sql = `
      SELECT pd.timestamp, pd.power_w, pd.voltage_v, pd.current_a
      FROM power_data pd
      WHERE pd.string_id = ?
    `;
    const params = [stringId];

    if (startTime) {
      sql += ' AND pd.timestamp >= ?';
      params.push(startTime);
    }
    if (endTime) {
      sql += ' AND pd.timestamp <= ?';
      params.push(endTime);
    }

    sql += ' ORDER BY pd.timestamp ASC';

    const stmt = db.prepare(sql);
    return stmt.all(...params);
  }
};

module.exports = powerDataService;
