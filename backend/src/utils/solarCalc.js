/**
 * Solar Calculation Utilities — Pure functions for irradiance, temperature,
 * wind speed, power, and voltage/current calculations.
 *
 * Used by: seed_data.js, generate_mock_data.js, liveDataSimulator.js
 *
 * All functions are deterministic given the same inputs (except randomNoise).
 */

// ============================================================
// Solar irradiance simulation (Gaussian-like curve)
// ============================================================
function getIrradiance(hour, minute, dayOfYear, options = {}) {
  const {
    sunrise = 6.5,
    sunset = 19.5,
    solarNoon = 13.0,
    peakMultiplier = 1000,
  } = options;

  const time = hour + minute / 60;
  if (time < sunrise || time > sunset) return 0;

  // Peak irradiance varies by day (weather variation)
  const dayVariation = 0.85 + 0.15 * Math.sin(dayOfYear * 0.7 + 1.3);
  const peakIrradiance = peakMultiplier * dayVariation;

  // Gaussian curve
  const sigma = (sunset - sunrise) / 4.5;
  const t = (time - solarNoon) / sigma;
  const irradiance = peakIrradiance * Math.exp(-0.5 * t * t);

  return Math.max(0, irradiance);
}

// ============================================================
// Temperature simulation
// ============================================================
function getTemperature(hour, minute, irradiance, options = {}) {
  const { baseMin = 15, baseAmplitude = 12, irradianceEffect = 8 } = options;
  const time = hour + minute / 60;
  const baseTemp = baseMin + baseAmplitude * Math.sin((time - 6) * Math.PI / 24);
  return baseTemp + (irradiance / 1000) * irradianceEffect;
}

// ============================================================
// Wind speed simulation
// ============================================================
function getWindSpeed(hour, minute, options = {}) {
  const { baseWind = 3, amplitude = 1.5, minWind = 0.5 } = options;
  const time = hour + minute / 60;
  const wind = baseWind + amplitude * Math.sin(time * Math.PI / 12);
  return Math.max(minWind, wind);
}

// ============================================================
// Random noise (Box-Muller transform)
// ============================================================
function randomNoise(mean = 0, std = 1) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z;
}

// ============================================================
// Calculate power for a single panel/string
// ============================================================
function calculateStringPower(irradiance, temperature, ratedPowerW, isAbnormal = false, reduction = 0) {
  if (irradiance < 10) return 0;

  // STC: 1000 W/m², 25°C
  // Temperature coefficient: -0.35%/°C for silicon panels
  const tempCoeff = -0.0035;
  const tempFactor = 1 + tempCoeff * (temperature - 25);

  // Irradiance factor (linear)
  const irrFactor = irradiance / 1000;

  // System losses: ~15% (cables, soiling, inverter efficiency, etc.)
  const systemLoss = 0.85;

  // Panel mismatch factor
  const mismatch = 0.98;

  let power = ratedPowerW * irrFactor * tempFactor * systemLoss * mismatch;

  // Abnormal string reduction
  if (isAbnormal) {
    power *= (1 - reduction);
  }

  // Add random noise (~2% of rated power)
  const noise = randomNoise(0, ratedPowerW * 0.02);
  power = Math.max(0, power + noise);

  return power;
}

// ============================================================
// Calculate voltage and current from power
// ============================================================
function calculateVI(power, ratedPowerW) {
  if (power < 1) return { voltage: 0, current: 0 };

  // Realistic string voltage: ~20-30 panels in series at Vmp ~38V
  // String voltage typically 600-1000V for utility-scale installations
  const vmpString = 850; // nominal string voltage at MPP
  // Voltage varies slightly with temperature and irradiance (±8%)
  const voltage = vmpString * (0.92 + 0.08 * (power / ratedPowerW));

  // Current from power
  const current = power / voltage;

  return { voltage: Math.round(voltage * 100) / 100, current: Math.round(current * 1000) / 1000 };
}

module.exports = {
  getIrradiance,
  getTemperature,
  getWindSpeed,
  randomNoise,
  calculateStringPower,
  calculateVI,
};
