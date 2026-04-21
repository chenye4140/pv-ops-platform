const express = require('express');
const router = express.Router();
const { db } = require('../models/database');

// GET /api/reports/daily/:stationId
// Generates a daily report preview for the specified station
router.get('/daily/:stationId', (req, res) => {
  try {
    const stationId = req.params.stationId;

    // Get station info
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) {
      return res.status(404).json({ success: false, error: 'Station not found' });
    }

    // Use the latest available date with data
    const latestTs = db.prepare(`
      SELECT MAX(pd.timestamp) as ts FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ?
    `).get(stationId);

    const refDate = latestTs && latestTs.ts ? new Date(latestTs.ts) : new Date();
    refDate.setHours(0, 0, 0, 0);
    const refStr = refDate.toISOString();
    const nextDate = new Date(refDate);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextStr = nextDate.toISOString();
    const dateStr = refDate.toISOString().split('T')[0];

    // Day's energy summary
    const energyData = db.prepare(`
      SELECT
        SUM(pd.power_w) * 0.25 / 1000 as total_energy_kwh,
        AVG(pd.power_w) / 1000 as avg_power_kw,
        MAX(pd.power_w) / 1000 as peak_power_kw,
        COUNT(*) as reading_count
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ? AND pd.timestamp >= ? AND pd.timestamp < ?
    `).get(stationId, refStr, nextStr);

    // Weather summary
    const weatherData = db.prepare(`
      SELECT
        AVG(irradiance_wm2) as avg_irradiance,
        MAX(irradiance_wm2) as peak_irradiance,
        AVG(temperature_c) as avg_temperature,
        AVG(wind_speed_ms) as avg_wind_speed
      FROM weather_data
      WHERE station_id = ? AND timestamp >= ? AND timestamp < ?
    `).get(stationId, refStr, nextStr);

    // Active alerts
    const alertsToday = db.prepare(`
      SELECT COUNT(*) as count FROM alerts
      WHERE station_id = ? AND status = 'active'
    `).get(stationId);

    // Performance ratio
    const capacityKW = station.capacity_mw * 1000;
    const totalEnergy = energyData.total_energy_kwh || 0;
    const pr = totalEnergy > 0
      ? Math.min(0.95, (totalEnergy / (capacityKW * 6)) * 100).toFixed(1)
      : '0.0';

    const report = {
      date: dateStr,
      station: {
        id: station.id,
        name: station.name,
        capacity_mw: station.capacity_mw
      },
      generation: {
        total_energy_kwh: Math.round(totalEnergy * 100) / 100,
        avg_power_kw: Math.round((energyData.avg_power_kw || 0) * 100) / 100,
        peak_power_kw: Math.round((energyData.peak_power_kw || 0) * 100) / 100,
        reading_count: energyData.reading_count || 0
      },
      weather: {
        avg_irradiance_wm2: Math.round((weatherData.avg_irradiance || 0) * 10) / 10,
        peak_irradiance_wm2: Math.round((weatherData.peak_irradiance || 0) * 10) / 10,
        avg_temperature_c: Math.round((weatherData.avg_temperature || 0) * 10) / 10,
        avg_wind_speed_ms: Math.round((weatherData.avg_wind_speed || 0) * 10) / 10
      },
      performance: {
        performance_ratio: parseFloat(pr),
        alerts_count: alertsToday.count
      }
    };

    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
