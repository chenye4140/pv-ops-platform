const { db } = require('../models/database');

const inverterService = {
  getByStationId(stationId) {
    const stmt = db.prepare(`
      SELECT i.*,
        (SELECT COUNT(*) FROM strings WHERE inverter_id = i.id) as string_count,
        (SELECT COUNT(*) FROM strings WHERE inverter_id = i.id AND status = 'abnormal') as abnormal_string_count
      FROM inverters i
      WHERE i.station_id = ?
      ORDER BY i.id
    `);
    return stmt.all(stationId);
  },

  getById(id) {
    const stmt = db.prepare('SELECT * FROM inverters WHERE id = ?');
    return stmt.get(id);
  },

  getStringsByInverterId(inverterId) {
    const stmt = db.prepare(`
      SELECT s.*,
        (SELECT MAX(pd.power_w) FROM power_data pd WHERE pd.string_id = s.id AND pd.timestamp >= datetime('now', '-1 hour')) as latest_power
      FROM strings s
      WHERE s.inverter_id = ?
      ORDER BY s.id
    `);
    return stmt.all(inverterId);
  }
};

module.exports = inverterService;
