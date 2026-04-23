/**
 * Generate Mock Data — Utility Module (re-exports from solarCalc)
 *
 * This module provides backward-compatible access to solar calculation
 * functions. For data seeding, use `node scripts/seed_data.js` instead.
 *
 * Usage:
 *   const { getIrradiance, calculateStringPower, ... } = require('./utils/generate_mock_data');
 *
 * @see {@link ./solarCalc.js} — the actual implementation
 * @see {@link ../../scripts/seed_data.js} — the data seeding script
 */

const solarCalc = require('./solarCalc');

// Re-export all calculation functions for backward compatibility
const {
  getIrradiance,
  getTemperature,
  getWindSpeed,
  randomNoise,
  calculateStringPower,
  calculateVI,
} = solarCalc;

module.exports = {
  getIrradiance,
  getTemperature,
  getWindSpeed,
  randomNoise,
  calculateStringPower,
  calculateVI,
};
