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
    // Resolve inverterId: could be numeric ID or name like 'INV-01'
    const inverter = db.prepare('SELECT id FROM inverters WHERE id = ? OR name = ?').get(inverterId, inverterId);
    if (!inverter) return [];
    const numericId = inverter.id;

    // Get the latest available timestamp for this inverter's strings
    const latestTs = db.prepare(`
      SELECT MAX(pd.timestamp) as ts FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      WHERE s.inverter_id = ?
    `).get(numericId);

    if (!latestTs || !latestTs.ts) {
      // No power data yet, return strings without latest_power
      const stmt = db.prepare(`
        SELECT s.* FROM strings s
        WHERE s.inverter_id = ?
        ORDER BY s.id
      `);
      return stmt.all(numericId).map(s => ({
        ...s,
        latest_power: 0,
        latest_voltage: 0,
        latest_current: 0,
      }));
    }

    // Use the latest timestamp to get power readings
    const stmt = db.prepare(`
      SELECT s.*,
        COALESCE(pd.power_w, 0) as latest_power,
        COALESCE(pd.voltage_v, 0) as latest_voltage,
        COALESCE(pd.current_a, 0) as latest_current
      FROM strings s
      LEFT JOIN power_data pd ON pd.string_id = s.id AND pd.timestamp = ?
      WHERE s.inverter_id = ?
      ORDER BY s.id
    `);
    return stmt.all(latestTs.ts, numericId);
  }
};

module.exports = inverterService;
