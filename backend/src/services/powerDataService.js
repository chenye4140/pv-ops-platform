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
  },

  create(data) {
    if (!data.string_id || data.power_w === undefined) {
      throw new Error('string_id and power_w are required');
    }

    const timestamp = data.timestamp || new Date().toISOString();
    const voltage = data.voltage_v || 0;
    const current = data.current_a || 0;

    const result = db.prepare(
      `INSERT INTO power_data (string_id, timestamp, power_w, voltage_v, current_a)
       VALUES (?, ?, ?, ?, ?)`
    ).run(stringId, timestamp, data.power_w, voltage, current);

    return db.prepare('SELECT * FROM power_data WHERE id = ?').get(result.lastInsertRowid);
  }
};

module.exports = powerDataService;
