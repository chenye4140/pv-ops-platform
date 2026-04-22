/**
 * Live Data Simulator — Generates realistic real-time power and weather data
 *
 * Reads existing station/inverter/string configurations from the database,
 * then writes simulated data every 60 seconds based on the current time of day.
 *
 * Controlled by: ENABLE_LIVE_SIMULATOR=true
 *
 * Features:
 * - Realistic solar curve (irradiance based on hour/day)
 * - Abnormal strings get reduced power per their DB status
 * - Auto-cleans data older than 30 days
 * - Batch transaction writes
 */
const { db } = require('../models/database');
const solarCalc = require('../utils/solarCalc');

let _intervalId = null;
let _isRunning = false;

// ============================================================
// Read current DB configuration
// ============================================================
function loadStations() {
  return db.prepare(`SELECT * FROM stations WHERE status = 'active'`).all();
}

function loadInvertersForStation(stationId) {
  return db.prepare(`SELECT * FROM inverters WHERE station_id = ?`).all(stationId);
}

function loadStringsForInverter(inverterId) {
  return db.prepare(`SELECT * FROM strings WHERE inverter_id = ?`).all(inverterId);
}

// ============================================================
// Data generation based on current time
// ============================================================
function generateWeatherForStation(station, now) {
  const hour = now.getHours();
  const minute = now.getMinutes();
  // Approximate day of year for solar calculation
  const startOfYear = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - startOfYear) / (1000 * 60 * 60 * 24));

  const irradiance = Math.max(0, solarCalc.getIrradiance(hour, minute, dayOfYear) + solarCalc.randomNoise(0, 15));
  const temperature = solarCalc.getTemperature(hour, minute, irradiance) + solarCalc.randomNoise(0, 0.5);
  const windSpeed = solarCalc.getWindSpeed(hour, minute) + solarCalc.randomNoise(0, 0.3);

  return {
    stationId: station.id,
    timestamp: now.toISOString(),
    irradiance: Math.round(irradiance * 10) / 10,
    temperature: Math.round(temperature * 10) / 10,
    windSpeed: Math.round(Math.max(0.1, windSpeed) * 100) / 100,
  };
}

function generatePowerForString(str, now) {
  const hour = now.getHours();
  const minute = now.getMinutes();
  const startOfYear = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - startOfYear) / (1000 * 60 * 60 * 24));

  const irradiance = Math.max(0, solarCalc.getIrradiance(hour, minute, dayOfYear) + solarCalc.randomNoise(0, 10));
  const temperature = solarCalc.getTemperature(hour, minute, irradiance) + solarCalc.randomNoise(0, 0.3);

  const isAbnormal = str.status === 'abnormal';
  // Estimate reduction for abnormal strings (20-35% range)
  const reduction = isAbnormal ? 0.25 : 0;

  const panelPower = solarCalc.calculateStringPower(irradiance, temperature, str.rated_power_w, isAbnormal, reduction);
  const power = panelPower * str.panel_count;
  const { voltage, current } = solarCalc.calculateVI(power, str.rated_power_w * str.panel_count);

  return {
    stringId: str.id,
    timestamp: now.toISOString(),
    power: Math.round(power * 100) / 100,
    voltage,
    current,
  };
}

// ============================================================
// Cleanup old data (older than 30 days)
// ============================================================
function cleanupOldData() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const powerResult = db.prepare(`DELETE FROM power_data WHERE timestamp < ?`).run(cutoff);
  const weatherResult = db.prepare(`DELETE FROM weather_data WHERE timestamp < ?`).run(cutoff);

  if (powerResult.changes > 0 || weatherResult.changes > 0) {
    console.log(`[LiveSimulator] Cleaned up ${powerResult.changes} power records, ${weatherResult.changes} weather records (older than 30 days)`);
  }
}

// ============================================================
// Main simulation tick
// ============================================================
function simulationTick() {
  if (_isRunning) {
    console.log('[LiveSimulator] Previous tick still running, skipping...');
    return;
  }
  _isRunning = true;

  const startTime = Date.now();
  const now = new Date();

  try {
    const stations = loadStations();
    if (stations.length === 0) {
      console.log('[LiveSimulator] No active stations found, skipping tick');
      _isRunning = false;
      return;
    }

    const powerRecords = [];
    const weatherRecords = [];

    for (const station of stations) {
      // Weather for this station
      weatherRecords.push(generateWeatherForStation(station, now));

      // Power for all strings in this station
      const inverters = loadInvertersForStation(station.id);
      for (const inverter of inverters) {
        const strings = loadStringsForInverter(inverter.id);
        for (const str of strings) {
          powerRecords.push(generatePowerForString(str, now));
        }
      }
    }

    // Batch write power data
    if (powerRecords.length > 0) {
      const stmtInsertPower = db.prepare(
        `INSERT INTO power_data (string_id, timestamp, power_w, voltage_v, current_a) VALUES (?, ?, ?, ?, ?)`
      );
      const insertPowerBatch = db.transaction((records) => {
        for (const r of records) {
          stmtInsertPower.run(r.stringId, r.timestamp, r.power, r.voltage, r.current);
        }
      });
      insertPowerBatch(powerRecords);
    }

    // Batch write weather data
    if (weatherRecords.length > 0) {
      const stmtInsertWeather = db.prepare(
        `INSERT INTO weather_data (station_id, timestamp, irradiance_wm2, temperature_c, wind_speed_ms) VALUES (?, ?, ?, ?, ?)`
      );
      const insertWeatherBatch = db.transaction((records) => {
        for (const r of records) {
          stmtInsertWeather.run(r.stationId, r.timestamp, r.irradiance, r.temperature, r.windSpeed);
        }
      });
      insertWeatherBatch(weatherRecords);
    }

    // Periodic cleanup (run once per hour, on the first tick of each hour)
    if (now.getMinutes() === 0) {
      cleanupOldData();
    }

    const duration = Date.now() - startTime;
    console.log(`[LiveSimulator] Wrote ${powerRecords.length} power records, ${weatherRecords.length} weather records (${duration}ms)`);
  } catch (err) {
    console.error(`[LiveSimulator] Error during simulation tick: ${err.message}`);
  } finally {
    _isRunning = false;
  }
}

// ============================================================
// Public API
// ============================================================
function start(intervalSeconds = 60) {
  if (_intervalId) {
    console.log('[LiveSimulator] Already running, ignoring duplicate start');
    return;
  }

  const intervalMs = intervalSeconds * 1000;
  console.log(`[LiveSimulator] Starting live data simulator (every ${intervalSeconds}s)...`);

  // Run immediately
  simulationTick();

  // Then on interval
  _intervalId = setInterval(simulationTick, intervalMs);
}

function stop() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    console.log('[LiveSimulator] Simulator stopped');
  }
}

function getStatus() {
  return {
    running: _intervalId !== null,
    isProcessing: _isRunning,
  };
}

module.exports = { start, stop, getStatus, simulationTick };
