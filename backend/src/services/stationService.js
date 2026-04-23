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

    // Use the latest available date with data (not necessarily "today")
    const latestTs = db.prepare(`
      SELECT MAX(pd.timestamp) as ts FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ?
    `).get(id);

    if (!latestTs || !latestTs.ts) {
      // No data yet, return zeroed overview
      return {
        station,
        todayEnergyKwh: 0, currentPowerKw: 0, abnormalCount: 0,
        activeAlerts: 0, performanceRatio: 0, inverterCount: 0, stringCount: 0,
      };
    }

    const latestDate = new Date(latestTs.ts);
    latestDate.setHours(0, 0, 0, 0);
    const latestStr = latestDate.toISOString();
    const nextDate = new Date(latestDate);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextStr = nextDate.toISOString();

    // Today's total energy (kWh) - integrate power over 15-min intervals
    const todayEnergy = db.prepare(`
      SELECT SUM(pd.power_w) * 0.25 / 1000 as energy_kwh
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ? AND pd.timestamp >= ? AND pd.timestamp < ?
    `).get(id, latestStr, nextStr);

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
      ? Math.min(95, (todayEnergy.energy_kwh / (capacityKW * 6)) * 100).toFixed(1)
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
  },

  /**
   * Get aggregated overview for ALL stations.
   * @returns {object} Combined overview data across all stations
   */
  getAllOverview() {
    const stations = this.getAll();

    // Find the latest timestamp across all stations
    const latestTs = db.prepare(`
      SELECT MAX(pd.timestamp) as ts FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
    `).get();

    if (!latestTs || !latestTs.ts) {
      return {
        stationCount: stations.length,
        todayEnergyKwh: 0, currentPowerKw: 0, abnormalCount: 0,
        activeAlerts: 0, performanceRatio: 0, inverterCount: 0, stringCount: 0,
      };
    }

    const latestDate = new Date(latestTs.ts);
    latestDate.setHours(0, 0, 0, 0);
    const latestStr = latestDate.toISOString();
    const nextDate = new Date(latestDate);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextStr = nextDate.toISOString();

    // Today's total energy (kWh) across all stations
    const todayEnergy = db.prepare(`
      SELECT SUM(pd.power_w) * 0.25 / 1000 as energy_kwh
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE pd.timestamp >= ? AND pd.timestamp < ?
    `).get(latestStr, nextStr);

    // Current power (latest reading) across all stations
    const currentPower = db.prepare(`
      SELECT SUM(pd.power_w) / 1000 as power_kw
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE pd.timestamp = (SELECT MAX(timestamp) FROM power_data)
    `).get();

    // Abnormal strings count across all stations
    const abnormalCount = db.prepare(`
      SELECT COUNT(*) as count FROM strings WHERE status = 'abnormal'
    `).get();

    // Active alerts count across all stations
    const activeAlerts = db.prepare(`
      SELECT COUNT(*) as count FROM alerts WHERE status = 'active'
    `).get();

    // Total capacity for PR calculation
    const totalCapacity = stations.reduce((sum, s) => sum + (s.capacity_mw || 0) * 1000, 0);
    const pr = todayEnergy.energy_kwh > 0
      ? Math.min(95, (todayEnergy.energy_kwh / (totalCapacity * 6)) * 100).toFixed(1)
      : '0.0';

    // Total inverter count
    const inverterCount = db.prepare(`SELECT COUNT(*) as count FROM inverters`).get();

    // Total string count
    const stringCount = db.prepare(`SELECT COUNT(*) as count FROM strings`).get();

    return {
      stationCount: stations.length,
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
