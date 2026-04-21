/**
 * Forecast Auto-Generate Service
 *
 * Automatically generates power forecasts for all active stations.
 * Used on server startup and scheduled daily regeneration.
 */
const forecastService = require('./forecastService');
const stationService = require('./stationService');

/**
 * Generate forecasts for all active stations for a given date.
 * Resilient: catches errors per-station, logs but doesn't crash.
 *
 * @param {string} forecastDate - YYYY-MM-DD (defaults to tomorrow)
 * @returns {object} { successCount, failureCount, results, errors }
 */
async function generateForecastsForAllStations(forecastDate = null) {
  const tomorrow = forecastDate || new Date(Date.now() + 86400000).toISOString().split('T')[0];

  const stations = stationService.getAll();
  const activeStations = stations.filter(s => s.status === 'active');

  const results = [];
  const errors = [];
  let successCount = 0;
  let failureCount = 0;

  console.log(`[ForecastAuto] Generating forecasts for ${activeStations.length} active stations for ${tomorrow}...`);

  for (const station of activeStations) {
    try {
      const forecast = forecastService.generateForecast(station.id, tomorrow);
      results.push({
        station_id: station.id,
        station_name: station.name,
        total_predicted_energy_kwh: forecast.total_predicted_energy_kwh,
        model_version: forecast.model_version,
      });
      successCount++;
      console.log(`[ForecastAuto] ✓ Station ${station.id} (${station.name}): ${forecast.total_predicted_energy_kwh} kWh predicted`);
    } catch (err) {
      failureCount++;
      const errorMsg = `Station ${station.id} (${station.name}): ${err.message}`;
      errors.push({ station_id: station.id, station_name: station.name, error: err.message });
      console.error(`[ForecastAuto] ✗ ${errorMsg}`);
    }
  }

  console.log(`[ForecastAuto] Done: ${successCount} succeeded, ${failureCount} failed out of ${activeStations.length} active stations`);

  return {
    forecast_date: tomorrow,
    total_stations: activeStations.length,
    success_count: successCount,
    failure_count: failureCount,
    results,
    errors,
  };
}

/**
 * Set up a daily cron job using setInterval to regenerate forecasts at 23:00.
 * Returns the interval ID so it can be cleared if needed.
 */
function scheduleDailyForecast(hour = 23, minute = 0) {
  function getNextTarget() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  function runAtNext() {
    const delay = getNextTarget().getTime() - Date.now();
    console.log(`[ForecastAuto] Next daily forecast scheduled in ${Math.round(delay / 60000)} minutes (at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')})`);
    return setTimeout(() => {
      generateForecastsForAllStations().catch(err => {
        console.error('[ForecastAuto] Scheduled generation failed:', err.message);
      });
      runAtNext(); // schedule next day
    }, delay);
  }

  const timer = runAtNext();

  return {
    timer,
    cancel: () => clearTimeout(timer),
  };
}

module.exports = {
  generateForecastsForAllStations,
  scheduleDailyForecast,
};
