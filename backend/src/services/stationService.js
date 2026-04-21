const { db } = require('../models/database');

const stationService = {
  getAll() {
    const stmt = db.prepare('SELECT * FROM stations ORDER BY id');
    return stmt.all();
  },

  getById(id) {
    const stmt = db.prepare('SELECT * FROM stations WHERE id = ?');
    return stmt.get(id);
  },

  getOverview(id) {
    const station = this.getById(id);
    if (!station) return null;

    // Today's date range
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString();

    // Today's total energy (kWh) - integrate power over 15-min intervals
    const todayEnergy = db.prepare(`
      SELECT SUM(pd.power_w) * 0.25 / 1000 as energy_kwh
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ? AND pd.timestamp >= ? AND pd.timestamp < ?
    `).get(id, todayStr, tomorrowStr);

    // Current power (latest reading)
    const currentPower = db.prepare(`
      SELECT SUM(pd.power_w) / 1000 as power_kw
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ? AND pd.timestamp = (
        SELECT MAX(pd2.timestamp) FROM power_data pd2
        JOIN strings s2 ON pd2.string_id = s2.id
        JOIN inverters i2 ON s2.inverter_id = i2.id
        WHERE i2.station_id = ?
      )
    `).get(id, id);

    // Abnormal strings count
    const abnormalCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM strings s
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ? AND s.status = 'abnormal'
    `).get(id);

    // Active alerts count
    const activeAlerts = db.prepare(`
      SELECT COUNT(*) as count FROM alerts
      WHERE station_id = ? AND status = 'active'
    `).get(id);

    // PR (Performance Ratio) calculation
    // PR = Actual Energy / (Capacity * Peak Sun Hours)
    // Simplified: use today's energy vs theoretical max
    const capacityKW = station.capacity_mw * 1000;
    const pr = todayEnergy.energy_kwh > 0
      ? Math.min(0.95, (todayEnergy.energy_kwh / (capacityKW * 6)) * 100).toFixed(1)
      : '0.0';

    // Total inverter count
    const inverterCount = db.prepare(`
      SELECT COUNT(*) as count FROM inverters WHERE station_id = ?
    `).get(id);

    // Total string count
    const stringCount = db.prepare(`
      SELECT COUNT(*) as count FROM strings s
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ?
    `).get(id);

    return {
      station,
      todayEnergyKwh: Math.round((todayEnergy.energy_kwh || 0) * 100) / 100,
      currentPowerKw: Math.round((currentPower.power_kw || 0) * 100) / 100,
      abnormalCount: abnormalCount.count,
      activeAlerts: activeAlerts.count,
      performanceRatio: parseFloat(pr),
      inverterCount: inverterCount.count,
      stringCount: stringCount.count,
    };
  }
};

module.exports = stationService;
