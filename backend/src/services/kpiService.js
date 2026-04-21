const { db } = require('../models/database');

/**
 * KPI Service — calculates Performance Ratio, equipment availability,
 * revenue estimates, and day-over-day comparisons for PV stations.
 */
const kpiService = {

  /**
   * Calculate PR (Performance Ratio) for a station.
   * PR = Actual Energy (kWh) / (Installed Capacity (kW) × Peak Sun Hours)
   * Peak sun hours default to 5.0 if weather data unavailable.
   *
   * @param {number} stationId
   * @param {string} dateStr — ISO date string for the day to calculate
   * @returns {object} { pr, actualEnergy, theoreticalEnergy, peakSunHours }
   */
  calculatePR(stationId, dateStr) {
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) return null;

    const capacityKW = station.capacity_mw * 1000;
    const date = new Date(dateStr);
    const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

    // Actual energy: integrate power over 15-min intervals (as in stationService)
    const energyResult = db.prepare(`
      SELECT SUM(pd.power_w) * 0.25 / 1000 as energy_kwh
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ? AND pd.timestamp >= ? AND pd.timestamp < ?
    `).get(stationId, dayStart.toISOString(), dayEnd.toISOString());

    const actualEnergy = energyResult.energy_kwh || 0;

    // Peak sun hours from weather data (average irradiance / 1000 W/m² × daylight hours)
    const weatherResult = db.prepare(`
      SELECT AVG(irradiance_wm2) as avg_irradiance,
             COUNT(*) as sample_count
      FROM weather_data
      WHERE station_id = ? AND timestamp >= ? AND timestamp < ?
    `).get(stationId, dayStart.toISOString(), dayEnd.toISOString());

    let peakSunHours = 5.0; // default
    if (weatherResult.sample_count > 0 && weatherResult.avg_irradiance > 0) {
      // Approximate PSH: integrate irradiance over daylight hours
      // PSH ≈ (avg_irradiance / 1000) × effective_hours
      // With 15-min samples, effective_hours ≈ sample_count × 0.25, but only count daytime
      peakSunHours = Math.min(8, Math.max(2, (weatherResult.avg_irradiance / 1000) * 10));
    }

    const theoreticalEnergy = capacityKW * peakSunHours;
    const pr = theoreticalEnergy > 0
      ? Math.min(99.9, (actualEnergy / theoreticalEnergy) * 100)
      : 0;

    return {
      pr: Math.round(pr * 10) / 10,
      actualEnergy: Math.round(actualEnergy * 100) / 100,
      theoreticalEnergy: Math.round(theoreticalEnergy * 100) / 100,
      peakSunHours: Math.round(peakSunHours * 10) / 10,
    };
  },

  /**
   * Calculate equipment availability rate.
   * Percentage of strings with power > 0 during daylight hours (6-18).
   *
   * @param {number} stationId
   * @param {string} dateStr
   * @returns {object} { availabilityRate, totalStrings, activeStrings, inverterOnline, inverterTotal }
   */
  calculateAvailability(stationId, dateStr) {
    const date = new Date(dateStr);
    const dayStart = new Date(date); dayStart.setHours(6, 0, 0, 0);
    const dayEnd = new Date(date); dayEnd.setHours(18, 0, 0, 0);

    // Total strings for this station
    const totalResult = db.prepare(`
      SELECT COUNT(*) as total
      FROM strings s
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ?
    `).get(stationId);

    const totalStrings = totalResult.total || 0;

    // Strings that produced power > 0 during daylight hours
    const activeResult = db.prepare(`
      SELECT COUNT(DISTINCT s.id) as active
      FROM strings s
      JOIN inverters i ON s.inverter_id = i.id
      JOIN power_data pd ON pd.string_id = s.id
      WHERE i.station_id = ? AND pd.timestamp >= ? AND pd.timestamp < ? AND pd.power_w > 0
    `).get(stationId, dayStart.toISOString(), dayEnd.toISOString());

    const activeStrings = activeResult.active || 0;

    // Inverter online count (inverter has at least one string with power > 0)
    const invOnlineResult = db.prepare(`
      SELECT COUNT(DISTINCT i.id) as online
      FROM inverters i
      JOIN strings s ON s.inverter_id = i.id
      JOIN power_data pd ON pd.string_id = s.id
      WHERE i.station_id = ? AND pd.timestamp >= ? AND pd.timestamp < ? AND pd.power_w > 0
    `).get(stationId, dayStart.toISOString(), dayEnd.toISOString());

    const invTotalResult = db.prepare(
      'SELECT COUNT(*) as total FROM inverters WHERE station_id = ?'
    ).get(stationId);

    const inverterOnline = invOnlineResult.online || 0;
    const inverterTotal = invTotalResult.total || 0;

    const availabilityRate = totalStrings > 0
      ? Math.round((activeStrings / totalStrings) * 1000) / 10
      : 0;

    const inverterAvailability = inverterTotal > 0
      ? Math.round((inverterOnline / inverterTotal) * 1000) / 10
      : 0;

    return {
      availabilityRate,
      totalStrings,
      activeStrings,
      inverterOnline,
      inverterTotal,
      inverterAvailability,
    };
  },

  /**
   * Calculate revenue estimate.
   * Revenue = Total Energy (kWh) × Electricity Price (CNY/kWh)
   *
   * @param {number} stationId
   * @param {string} dateStr
   * @param {number} pricePerKwh — default 0.4 CNY/kWh
   * @returns {object} { revenue, energy, price }
   */
  calculateRevenue(stationId, dateStr, pricePerKwh = 0.4) {
    const pr = this.calculatePR(stationId, dateStr);
    if (!pr) return { revenue: 0, energy: 0, price: pricePerKwh };

    const energy = pr.actualEnergy;
    const revenue = Math.round(energy * pricePerKwh * 100) / 100;

    return { revenue, energy, price: pricePerKwh };
  },

  /**
   * Calculate overall efficiency (综合效率).
   * Ratio of actual output vs rated capacity during daylight.
   *
   * @param {number} stationId
   * @param {string} dateStr
   * @returns {object} { overallEfficiency, currentPower, ratedCapacity, utilizationHours }
   */
  calculateEfficiency(stationId, dateStr) {
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) return null;

    const ratedCapacityKW = station.capacity_mw * 1000;

    // Current power (latest reading)
    const latestTs = db.prepare(`
      SELECT MAX(pd.timestamp) as ts FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ?
    `).get(stationId);

    let currentPowerKW = 0;
    if (latestTs && latestTs.ts) {
      const powerResult = db.prepare(`
        SELECT SUM(pd.power_w) / 1000 as power_kw
        FROM power_data pd
        JOIN strings s ON pd.string_id = s.id
        JOIN inverters i ON s.inverter_id = i.id
        WHERE i.station_id = ? AND pd.timestamp = ?
      `).get(stationId, latestTs.ts);
      currentPowerKW = powerResult.power_kw || 0;
    }

    // Today's energy
    const pr = this.calculatePR(stationId, dateStr);
    const energyKwh = pr ? pr.actualEnergy : 0;

    // Utilization hours = energy / capacity
    const utilizationHours = ratedCapacityKW > 0
      ? Math.round((energyKwh / ratedCapacityKW) * 10) / 10
      : 0;

    // Overall efficiency = average output / rated capacity during production hours
    // Simplified: utilizationHours / daylightHours (assume 10h)
    const overallEfficiency = ratedCapacityKW > 0
      ? Math.min(100, Math.round((energyKwh / (ratedCapacityKW * 10)) * 1000) / 10)
      : 0;

    return {
      overallEfficiency,
      currentPower: Math.round(currentPowerKW * 100) / 100,
      ratedCapacity: ratedCapacityKW,
      utilizationHours,
      energyKwh,
    };
  },

  /**
   * Get day-over-day comparison for a specific KPI metric.
   *
   * @param {number} stationId
   * @param {string} metric — 'energy' | 'pr' | 'revenue' | 'availability'
   * @returns {object} { today, yesterday, change, changePercent }
   */
  getDayOverDay(stationId, metric) {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let todayVal, yesterdayVal;

    switch (metric) {
      case 'energy': {
        const t = this.calculatePR(stationId, today.toISOString());
        const y = this.calculatePR(stationId, yesterday.toISOString());
        todayVal = t ? t.actualEnergy : 0;
        yesterdayVal = y ? y.actualEnergy : 0;
        break;
      }
      case 'pr': {
        const t = this.calculatePR(stationId, today.toISOString());
        const y = this.calculatePR(stationId, yesterday.toISOString());
        todayVal = t ? t.pr : 0;
        yesterdayVal = y ? y.pr : 0;
        break;
      }
      case 'revenue': {
        const t = this.calculateRevenue(stationId, today.toISOString());
        const y = this.calculateRevenue(stationId, yesterday.toISOString());
        todayVal = t.revenue;
        yesterdayVal = y.revenue;
        break;
      }
      case 'availability': {
        const t = this.calculateAvailability(stationId, today.toISOString());
        const y = this.calculateAvailability(stationId, yesterday.toISOString());
        todayVal = t.availabilityRate;
        yesterdayVal = y.availabilityRate;
        break;
      }
      default:
        return { today: 0, yesterday: 0, change: 0, changePercent: 0 };
    }

    const change = Math.round((todayVal - yesterdayVal) * 100) / 100;
    const changePercent = yesterdayVal !== 0
      ? Math.round((change / yesterdayVal) * 1000) / 10
      : 0;

    return { today: todayVal, yesterday: yesterdayVal, change, changePercent };
  },

  /**
   * Get combined dashboard KPI data for a single station.
   *
   * @param {number} stationId
   * @returns {object} Complete KPI dashboard data
   */
  getDashboardKPI(stationId) {
    const today = new Date().toISOString();
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) return null;

    const pr = this.calculatePR(stationId, today);
    const availability = this.calculateAvailability(stationId, today);
    const revenue = this.calculateRevenue(stationId, today);
    const efficiency = this.calculateEfficiency(stationId, today);

    // Day-over-day comparisons
    const energyDod = this.getDayOverDay(stationId, 'energy');
    const prDod = this.getDayOverDay(stationId, 'pr');
    const revenueDod = this.getDayOverDay(stationId, 'revenue');
    const availabilityDod = this.getDayOverDay(stationId, 'availability');

    // Active alert counts by severity
    const alertCounts = db.prepare(`
      SELECT severity, COUNT(*) as count
      FROM alerts
      WHERE station_id = ? AND status = 'active'
      GROUP BY severity
    `).all(stationId);

    const alertsBySeverity = { critical: 0, warning: 0, info: 0 };
    alertCounts.forEach(row => {
      alertsBySeverity[row.severity] = row.count;
    });

    const totalActiveAlerts = Object.values(alertsBySeverity).reduce((a, b) => a + b, 0);

    return {
      station: { id: station.id, name: station.name, capacity_mw: station.capacity_mw, location: station.location },
      pr,
      availability,
      revenue,
      efficiency,
      dayOverDay: {
        energy: energyDod,
        pr: prDod,
        revenue: revenueDod,
        availability: availabilityDod,
      },
      alerts: {
        totalActive: totalActiveAlerts,
        critical: alertsBySeverity.critical,
        warning: alertsBySeverity.warning,
        info: alertsBySeverity.info,
      },
    };
  },

  /**
   * Get PR and key metrics for ALL stations (multi-station overview).
   *
   * @returns {Array} Array of station KPI summaries
   */
  getAllStationsKPI() {
    const stations = db.prepare('SELECT * FROM stations ORDER BY id').all();
    const today = new Date().toISOString();

    return stations.map(station => {
      const pr = this.calculatePR(station.id, today);
      const availability = this.calculateAvailability(station.id, today);
      const revenue = this.calculateRevenue(station.id, today);
      const efficiency = this.calculateEfficiency(station.id, today);

      const activeAlerts = db.prepare(
        "SELECT COUNT(*) as count FROM alerts WHERE station_id = ? AND status = 'active'"
      ).get(station.id);

      return {
        station_id: station.id,
        station_name: station.name,
        capacity_mw: station.capacity_mw,
        location: station.location,
        pr: pr ? pr.pr : 0,
        actual_energy: pr ? pr.actualEnergy : 0,
        availability_rate: availability ? availability.availabilityRate : 0,
        inverter_availability: availability ? availability.inverterAvailability : 0,
        revenue: revenue ? revenue.revenue : 0,
        overall_efficiency: efficiency ? efficiency.overallEfficiency : 0,
        utilization_hours: efficiency ? efficiency.utilizationHours : 0,
        active_alerts: activeAlerts ? activeAlerts.count : 0,
      };
    });
  },

  /**
   * Get alert severity breakdown for a station (or all stations).
   *
   * @param {number|null} stationId — null for all stations
   * @returns {object} { critical, warning, info, total }
   */
  getAlertSeverityBreakdown(stationId = null) {
    let sql = `
      SELECT severity, COUNT(*) as count
      FROM alerts
      WHERE status = 'active'
    `;
    const params = [];

    if (stationId) {
      sql += ' AND station_id = ?';
      params.push(stationId);
    }

    sql += ' GROUP BY severity';

    const rows = db.prepare(sql).all(...params);

    const result = { critical: 0, warning: 0, info: 0, total: 0 };
    rows.forEach(row => {
      if (row.severity in result) {
        result[row.severity] = row.count;
        result.total += row.count;
      }
    });

    return result;
  },
};

module.exports = kpiService;
