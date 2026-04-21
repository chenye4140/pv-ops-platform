/**
 * Forecast Auto-Generate Service
 *
 * Automatically generates power forecasts for all active stations.
 * Used on server startup and scheduled daily regeneration.
 * Enhanced: generates forecasts for 3 days ahead and calls both
 * baseline and weighted_avg models.
 */
const forecastService = require('./forecastService');
const forecastEnhancedService = require('./forecastEnhancedService');
const stationService = require('./stationService');

/**
 * Generate forecasts for all active stations for a given date.
 * Generates both baseline and weighted_avg models.
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
      // Generate baseline forecast
      const forecast = forecastService.generateForecast(station.id, tomorrow);
      results.push({
        station_id: station.id,
        station_name: station.name,
        total_predicted_energy_kwh: forecast.total_predicted_energy_kwh,
        model_version: forecast.model_version,
      });

      // Generate weighted_avg enhanced forecast
      try {
        const enhancedForecast = forecastEnhancedService.generateWeightedAvgForecast(station.id, tomorrow);
        results.push({
          station_id: station.id,
          station_name: station.name,
          total_predicted_energy_kwh: enhancedForecast.total_predicted_energy_kwh,
          model_version: enhancedForecast.model_version,
        });
      } catch (enhErr) {
        console.warn(`[ForecastAuto] Enhanced forecast for ${station.name}: ${enhErr.message}`);
      }

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
 * Generate multi-day forecasts (3 days ahead) for all active stations.
 * Calls both baseline and weighted_avg models for each day.
 */
async function generateMultiDayForecasts(daysAhead = 3) {
  const results = [];
  let totalSuccess = 0;
  let totalFailures = 0;

  console.log(`[ForecastAuto] Generating ${daysAhead}-day forecasts for all active stations...`);

  for (let d = 1; d <= daysAhead; d++) {
    const forecastDate = new Date(Date.now() + d * 86400000).toISOString().split('T')[0];
    try {
      const dayResult = await generateForecastsForAllStations(forecastDate);
      results.push(dayResult);
      totalSuccess += dayResult.success_count;
      totalFailures += dayResult.failure_count;
    } catch (err) {
      console.error(`[ForecastAuto] Failed to generate forecasts for ${forecastDate}: ${err.message}`);
      totalFailures++;
    }
  }

  console.log(`[ForecastAuto] Multi-day generation complete: ${totalSuccess} succeeded, ${totalFailures} failed`);

  return {
    days_generated: daysAhead,
    total_success: totalSuccess,
    total_failures: totalFailures,
    daily_results: results,
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
      generateMultiDayForecasts(3).catch(err => {
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
  generateMultiDayForecasts,
  scheduleDailyForecast,
};
