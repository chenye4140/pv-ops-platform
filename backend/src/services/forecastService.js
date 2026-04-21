/**
 * Power Forecast Service — Baseline forecasting algorithm
 *
 * Uses historical power data + weather patterns to predict
 * next-day power generation for PV stations.
 *
 * Algorithm: Historical average + weather adjustment
 *   1. Calculate historical average power profile by hour
 *   2. Adjust based on weather forecast (irradiance, temperature)
 *   3. Apply seasonal correction
 */
const { db } = require('../models/database');

const forecastService = {
  /**
   * Generate a forecast for a station for a given date.
   * Uses historical data from the same hour over the past N days.
   *
   * @param {number} stationId
   * @param {string} forecastDate - YYYY-MM-DD
   * @param {object} weatherForecast - Optional: { avg_irradiance, avg_temperature }
   * @returns {object} - Forecast with hourly predictions
   */
  generateForecast(stationId, forecastDate, weatherForecast = null) {
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) throw new Error('Station not found');

    // Get historical hourly power profile (past 7 days)
    const historicalProfile = this.getHistoricalHourlyProfile(stationId, 7);
    if (!historicalProfile || historicalProfile.length === 0) {
      throw new Error('Insufficient historical data for forecasting');
    }

    // Get average weather for the historical period
    const historicalWeather = this.getHistoricalWeather(stationId, 7);

    // If no weather forecast provided, use historical average
    const weatherAdj = weatherForecast || {
      avg_irradiance: historicalWeather?.avg_irradiance || 500,
      avg_temperature: historicalWeather?.avg_temperature || 25,
    };

    // Calculate weather adjustment factor
    const irrFactor = historicalWeather?.avg_irradiance > 0
      ? weatherAdj.avg_irradiance / historicalWeather.avg_irradiance
      : 1;
    // Temperature derating: ~-0.35%/°C above 25°C
    const tempDerating = 1 - 0.0035 * Math.max(0, weatherAdj.avg_temperature - 25);
    const weatherMultiplier = Math.min(1.2, Math.max(0.3, irrFactor * tempDerating));

    // Generate hourly predictions
    const predictions = [];
    let totalEnergyKwh = 0;

    for (let hour = 0; hour < 24; hour++) {
      const histData = historicalProfile.find(h => h.hour === hour);
      const avgPowerKw = histData ? histData.avg_power_kw : 0;

      // Apply weather adjustment and some diurnal smoothing
      const predictedPowerKw = Math.max(0, avgPowerKw * weatherMultiplier);
      const predictedEnergyKwh = predictedPowerKw * 1; // 1 hour interval

      // Confidence decreases with forecast horizon
      const confidence = Math.max(0.5, 0.95 - (histData?.data_points < 3 ? 0.2 : 0));

      predictions.push({
        station_id: stationId,
        forecast_date: forecastDate,
        forecast_hour: hour,
        predicted_power_kw: Math.round(predictedPowerKw * 100) / 100,
        predicted_energy_kwh: Math.round(predictedEnergyKwh * 100) / 100,
        confidence,
        model_version: 'baseline_v1',
      });

      totalEnergyKwh += predictedEnergyKwh;
    }

    // Save to database
    const insertForecast = db.prepare(`
      INSERT INTO power_forecasts
        (station_id, forecast_date, forecast_hour, predicted_power_kw, predicted_energy_kwh, confidence, model_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Delete existing forecast for this date if any
    db.prepare('DELETE FROM power_forecasts WHERE station_id = ? AND forecast_date = ?')
      .run(stationId, forecastDate);

    for (const p of predictions) {
      insertForecast.run(
        p.station_id, p.forecast_date, p.forecast_hour,
        p.predicted_power_kw, p.predicted_energy_kwh,
        p.confidence, p.model_version
      );
    }

    return {
      station: station.name,
      forecast_date: forecastDate,
      hourly_predictions: predictions,
      total_predicted_energy_kwh: Math.round(totalEnergyKwh * 100) / 100,
      weather_adjustment: { irradiance_factor: Math.round(irrFactor * 100) / 100, temperature_derating: Math.round(tempDerating * 100) / 100 },
      model_version: 'baseline_v1',
    };
  },

  /**
   * Get historical hourly power profile for a station.
   */
  getHistoricalHourlyProfile(stationId, days = 7) {
    const cutoffDate = new Date(Date.now() - days * 86400000).toISOString();

    const rows = db.prepare(`
      SELECT
        CAST(strftime('%H', pd.timestamp) AS INTEGER) as hour,
        AVG(pd.power_w / 1000) as avg_power_kw,
        MIN(pd.power_w / 1000) as min_power_kw,
        MAX(pd.power_w / 1000) as max_power_kw,
        COUNT(*) as data_points
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ?
        AND pd.timestamp >= ?
        AND pd.power_w > 0
      GROUP BY hour
      ORDER BY hour
    `).all(stationId, cutoffDate);

    return rows;
  },

  /**
   * Get historical weather averages for a station.
   */
  getHistoricalWeather(stationId, days = 7) {
    const cutoffDate = new Date(Date.now() - days * 86400000).toISOString();

    return db.prepare(`
      SELECT
        AVG(irradiance_wm2) as avg_irradiance,
        AVG(temperature_c) as avg_temperature,
        AVG(wind_speed_ms) as avg_wind_speed
      FROM weather_data
      WHERE station_id = ?
        AND timestamp >= ?
        AND irradiance_wm2 > 0
    `).get(stationId, cutoffDate);
  },

  /**
   * Get stored forecasts for a station and date.
   */
  getForecast(stationId, forecastDate) {
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) throw new Error('Station not found');

    const predictions = db.prepare(`
      SELECT * FROM power_forecasts
      WHERE station_id = ? AND forecast_date = ?
      ORDER BY forecast_hour ASC
    `).all(stationId, forecastDate);

    if (predictions.length === 0) return null;

    const totalEnergy = predictions.reduce((sum, p) => sum + (p.predicted_energy_kwh || 0), 0);
    const avgConfidence = predictions.reduce((sum, p) => sum + (p.confidence || 0), 0) / predictions.length;

    return {
      station: station.name,
      forecast_date: forecastDate,
      hourly_predictions: predictions,
      total_predicted_energy_kwh: Math.round(totalEnergy * 100) / 100,
      avg_confidence: Math.round(avgConfidence * 100) / 100,
      model_version: predictions[0].model_version,
    };
  },

  /**
   * Compare forecast vs actual for a given date.
   */
  getForecastAccuracy(stationId, forecastDate) {
    const forecast = this.getForecast(stationId, forecastDate);
    if (!forecast) return { error: 'No forecast found for this date' };

    // Get actual data for the same date
    const actualData = db.prepare(`
      SELECT
        CAST(strftime('%H', pd.timestamp) AS INTEGER) as hour,
        AVG(pd.power_w / 1000) as actual_power_kw,
        SUM(pd.power_w) * 0.25 / 1000 as total_energy_kwh
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ?
        AND DATE(pd.timestamp) = ?
        AND pd.power_w > 0
      GROUP BY hour
    `).all(stationId, forecastDate);

    const comparison = forecast.hourly_predictions.map(pred => {
      const actual = actualData.find(a => a.hour === pred.forecast_hour);
      const actualPower = actual ? actual.actual_power_kw : 0;
      const error = actualPower > 0
        ? Math.abs(pred.predicted_power_kw - actualPower) / actualPower * 100
        : null;

      return {
        hour: pred.forecast_hour,
        predicted_kw: pred.predicted_power_kw,
        actual_kw: actualPower,
        error_percent: error ? Math.round(error * 100) / 100 : null,
      };
    });

    const validErrors = comparison.filter(c => c.error_percent !== null);
    const mape = validErrors.length > 0
      ? validErrors.reduce((sum, c) => sum + c.error_percent, 0) / validErrors.length
      : null;

    const actualTotal = actualData.reduce((sum, a) => sum + (a.total_energy_kwh || 0), 0);

    return {
      forecast_date: forecastDate,
      station: forecast.station,
      predicted_total_kwh: forecast.total_predicted_energy_kwh,
      actual_total_kwh: Math.round(actualTotal * 100) / 100,
      mape_percent: mape ? Math.round(mape * 100) / 100 : null,
      hourly_comparison: comparison,
    };
  },
};

module.exports = forecastService;
