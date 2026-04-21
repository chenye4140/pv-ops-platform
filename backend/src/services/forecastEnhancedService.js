/**
 * Enhanced Forecast Service — Trend analysis, multi-model comparison,
 * confidence intervals, and station aggregation.
 *
 * Uses the existing database connection from models/database.
 */
const { db } = require('../models/database');

const forecastEnhancedService = {

  /* ============================================================
     1. CONFIDENCE INTERVALS
     ============================================================ */

  /**
   * Calculate confidence intervals for a station's historical hourly data.
   * Returns { hour, mean, std, p5, p95, p50 } for each hour.
   */
  getHistoricalStats(stationId, days = 14) {
    const cutoffDate = new Date(Date.now() - days * 86400000).toISOString();

    // We need per-hour raw power values to compute std dev
    const rows = db.prepare(`
      SELECT
        CAST(strftime('%H', pd.timestamp) AS INTEGER) as hour,
        pd.power_w / 1000 as power_kw
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ?
        AND pd.timestamp >= ?
        AND pd.power_w > 0
      ORDER BY hour
    `).all(stationId, cutoffDate);

    // Group by hour
    const groups = {};
    for (const r of rows) {
      if (!groups[r.hour]) groups[r.hour] = [];
      groups[r.hour].push(r.power_kw);
    }

    const stats = [];
    for (let h = 0; h < 24; h++) {
      const vals = groups[h] || [];
      if (vals.length === 0) {
        stats.push({ hour: h, mean: 0, std: 0, p5: 0, p50: 0, p95: 0, count: 0 });
        continue;
      }
      const n = vals.length;
      const mean = vals.reduce((a, b) => a + b, 0) / n;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
      const std = Math.sqrt(variance);
      const sorted = [...vals].sort((a, b) => a - b);

      stats.push({
        hour: h,
        mean: Math.round(mean * 100) / 100,
        std: Math.round(std * 100) / 100,
        p5: Math.round(sorted[Math.floor(n * 0.05)] * 100) / 100,
        p50: Math.round(sorted[Math.floor(n * 0.5)] * 100) / 100,
        p95: Math.round(sorted[Math.min(Math.ceil(n * 0.95), n - 1)] * 100) / 100,
        count: n,
      });
    }
    return stats;
  },

  /* ============================================================
     2. WEIGHTED AVG MODEL
     ============================================================ */

  /**
   * Generate a weighted_avg forecast:
   *   60% baseline + 40% recent 3-day trend adjustment.
   */
  generateWeightedAvgForecast(stationId, forecastDate, weatherForecast = null) {
    const forecastService = require('./forecastService');

    // Get baseline forecast
    const baselineResult = forecastService.generateForecast(stationId, forecastDate, weatherForecast);
    const baselinePredictions = baselineResult.hourly_predictions;

    // Get historical stats for confidence intervals
    const histStats = this.getHistoricalStats(stationId, 14);

    // Get recent 3-day trend (average power per hour for last 3 days of data)
    const recentTrend = this.getRecentTrend(stationId, 3);

    const predictions = baselinePredictions.map(bp => {
      const stat = histStats.find(s => s.hour === bp.forecast_hour);
      const trend = recentTrend.find(t => t.hour === bp.forecast_hour);

      // Weighted combination: 60% baseline + 40% recent trend
      const trendPower = trend ? trend.avg_power_kw : bp.predicted_power_kw;
      const weightedPower = Math.max(0,
        0.6 * bp.predicted_power_kw + 0.4 * trendPower
      );

      // Confidence interval using historical std
      const std = stat ? stat.std : bp.predicted_power_kw * 0.15;
      const upperBound = Math.round((weightedPower + 1.96 * std) * 100) / 100;
      const lowerBound = Math.round(Math.max(0, weightedPower - 1.96 * std) * 100) / 100;

      // Adjust confidence based on data quality
      const dataQuality = stat && stat.count > 0
        ? Math.min(1, stat.count / 10)
        : 0.5;
      const confidence = Math.round(Math.max(0.5, 0.92 * dataQuality) * 100) / 100;

      return {
        ...bp,
        predicted_power_kw: Math.round(weightedPower * 100) / 100,
        predicted_energy_kwh: Math.round(weightedPower * 1) * 100 / 100,
        confidence,
        model_version: 'weighted_avg_v1',
        confidence_upper: upperBound,
        confidence_lower: lowerBound,
        historical_std: std,
      };
    });

    // Save weighted_avg predictions to DB
    const insertForecast = db.prepare(`
      INSERT INTO power_forecasts
        (station_id, forecast_date, forecast_hour, predicted_power_kw, predicted_energy_kwh, confidence, model_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const totalEnergy = predictions.reduce((sum, p) => sum + p.predicted_energy_kwh, 0);

    return {
      station: baselineResult.station,
      forecast_date: forecastDate,
      hourly_predictions: predictions,
      total_predicted_energy_kwh: Math.round(totalEnergy * 100) / 100,
      model_version: 'weighted_avg_v1',
    };
  },

  /**
   * Get recent trend: average power per hour for the last N days of actual data.
   */
  getRecentTrend(stationId, days = 3) {
    const cutoffDate = new Date(Date.now() - days * 86400000).toISOString();

    return db.prepare(`
      SELECT
        CAST(strftime('%H', pd.timestamp) AS INTEGER) as hour,
        AVG(pd.power_w / 1000) as avg_power_kw,
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
  },

  /* ============================================================
     3. ENHANCED FORECAST (with confidence intervals)
     ============================================================ */

  /**
   * Get enhanced forecast for a station with confidence intervals.
   * Supports model parameter: 'baseline' or 'weighted_avg'.
   */
  getEnhancedForecast(stationId, forecastDate, model = 'weighted_avg') {
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) throw new Error('Station not found');

    let predictions;

    if (model === 'weighted_avg') {
      // Try to get from DB first
      predictions = db.prepare(`
        SELECT * FROM power_forecasts
        WHERE station_id = ? AND forecast_date = ? AND model_version = 'weighted_avg_v1'
        ORDER BY forecast_hour ASC
      `).all(stationId, forecastDate);

      if (predictions.length === 0) {
        // Generate on-the-fly
        const result = this.generateWeightedAvgForecast(stationId, forecastDate);
        predictions = result.hourly_predictions;
      }
    } else {
      predictions = db.prepare(`
        SELECT * FROM power_forecasts
        WHERE station_id = ? AND forecast_date = ? AND model_version LIKE 'baseline%'
        ORDER BY forecast_hour ASC
      `).all(stationId, forecastDate);
    }

    if (predictions.length === 0) return null;

    // Add confidence intervals if not present
    const histStats = this.getHistoricalStats(stationId, 14);
    predictions = predictions.map(p => {
      const stat = histStats.find(s => s.hour === p.forecast_hour);
      const std = stat ? stat.std : p.predicted_power_kw * 0.15;
      return {
        ...p,
        confidence_upper: p.confidence_upper || Math.round((p.predicted_power_kw + 1.96 * std) * 100) / 100,
        confidence_lower: p.confidence_lower || Math.round(Math.max(0, p.predicted_power_kw - 1.96 * std) * 100) / 100,
        historical_std: p.historical_std || Math.round(std * 100) / 100,
      };
    });

    const totalEnergy = predictions.reduce((sum, p) => sum + (p.predicted_energy_kwh || 0), 0);
    const avgConfidence = predictions.reduce((sum, p) => sum + (p.confidence || 0), 0) / predictions.length;

    return {
      station: station.name,
      forecast_date: forecastDate,
      model,
      hourly_predictions: predictions,
      total_predicted_energy_kwh: Math.round(totalEnergy * 100) / 100,
      avg_confidence: Math.round(avgConfidence * 100) / 100,
    };
  },

  /* ============================================================
     4. MODEL COMPARISON
     ============================================================ */

  /**
   * Compare baseline vs weighted_avg models for recent dates.
   */
  compareModels(stationId, numDays = 3) {
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) throw new Error('Station not found');

    const results = [];
    for (let d = 0; d < numDays; d++) {
      const date = new Date(Date.now() + (d === 0 ? 0 : d) * 86400000).toISOString().split('T')[0];

      // Get baseline predictions
      const baselinePreds = db.prepare(`
        SELECT forecast_hour, predicted_power_kw, predicted_energy_kwh, confidence
        FROM power_forecasts
        WHERE station_id = ? AND forecast_date = ? AND model_version LIKE 'baseline%'
        ORDER BY forecast_hour ASC
      `).all(stationId, date);

      // Get weighted_avg predictions (generate if needed)
      let waPreds = db.prepare(`
        SELECT forecast_hour, predicted_power_kw, predicted_energy_kwh, confidence
        FROM power_forecasts
        WHERE station_id = ? AND forecast_date = ? AND model_version = 'weighted_avg_v1'
        ORDER BY forecast_hour ASC
      `).all(stationId, date);

      if (waPreds.length === 0) {
        const waResult = this.generateWeightedAvgForecast(stationId, date);
        waPreds = waResult.hourly_predictions;
      }

      // Calculate accuracy if actual data exists
      const accuracy = this.calculateModelAccuracy(stationId, date);

      const baselineTotal = baselinePreds.reduce((s, p) => s + (p.predicted_energy_kwh || 0), 0);
      const waTotal = waPreds.reduce((s, p) => s + (p.predicted_energy_kwh || 0), 0);

      results.push({
        date,
        baseline: {
          total_energy_kwh: Math.round(baselineTotal * 100) / 100,
          avg_confidence: baselinePreds.length > 0
            ? Math.round(baselinePreds.reduce((s, p) => s + (p.confidence || 0), 0) / baselinePreds.length * 100) / 100
            : 0,
          model_version: 'baseline_v1',
        },
        weighted_avg: {
          total_energy_kwh: Math.round(waTotal * 100) / 100,
          avg_confidence: waPreds.length > 0
            ? Math.round(waPreds.reduce((s, p) => s + (p.confidence || 0), 0) / waPreds.length * 100) / 100
            : 0,
          model_version: 'weighted_avg_v1',
        },
        accuracy,
      });
    }

    return {
      station: station.name,
      station_id: stationId,
      comparison: results,
    };
  },

  /**
   * Calculate model accuracy for a given date.
   * Compares predicted vs actual power by hour.
   */
  calculateModelAccuracy(stationId, forecastDate) {
    // Get actual hourly averages for the forecast date
    const actualData = db.prepare(`
      SELECT
        CAST(strftime('%H', pd.timestamp) AS INTEGER) as hour,
        AVG(pd.power_w / 1000) as actual_power_kw
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ?
        AND DATE(pd.timestamp) = ?
        AND pd.power_w > 0
      GROUP BY hour
    `).all(stationId, forecastDate);

    if (actualData.length === 0) return { mape: null, rmse: null, note: 'No actual data for this date' };

    const forecasts = db.prepare(`
      SELECT forecast_hour, predicted_power_kw
      FROM power_forecasts
      WHERE station_id = ? AND forecast_date = ?
      ORDER BY forecast_hour ASC
    `).all(stationId, forecastDate);

    let totalAPE = 0, totalSE = 0, validCount = 0;

    for (const pred of forecasts) {
      const actual = actualData.find(a => a.hour === pred.forecast_hour);
      if (actual && actual.actual_power_kw > 0) {
        const error = Math.abs(pred.predicted_power_kw - actual.actual_power_kw);
        const ape = (error / actual.actual_power_kw) * 100;
        totalAPE += ape;
        totalSE += error * error;
        validCount++;
      }
    }

    const mape = validCount > 0 ? Math.round(totalAPE / validCount * 100) / 100 : null;
    const rmse = validCount > 0 ? Math.round(Math.sqrt(totalSE / validCount) * 100) / 100 : null;

    return { mape, rmse, valid_hours: validCount };
  },

  /* ============================================================
     5. TREND ANALYSIS (7-day)
     ============================================================ */

  /**
   * 7-day trend analysis with accuracy metrics.
   */
  getTrendAnalysis(stationId) {
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) throw new Error('Station not found');

    const trendDays = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(Date.now() - d * 86400000).toISOString().split('T')[0];

      // Get forecast for this date
      const forecast = db.prepare(`
        SELECT forecast_hour, predicted_power_kw, predicted_energy_kwh
        FROM power_forecasts
        WHERE station_id = ? AND forecast_date = ?
        ORDER BY forecast_hour ASC
      `).all(stationId, date);

      // Get actual data
      const actualData = db.prepare(`
        SELECT
          CAST(strftime('%H', pd.timestamp) AS INTEGER) as hour,
          AVG(pd.power_w / 1000) as actual_power_kw,
          SUM(pd.power_w) * 0.25 / 1000 as hourly_energy_kwh
        FROM power_data pd
        JOIN strings s ON pd.string_id = s.id
        JOIN inverters i ON s.inverter_id = i.id
        WHERE i.station_id = ?
          AND DATE(pd.timestamp) = ?
          AND pd.power_w > 0
        GROUP BY hour
      `).all(stationId, date);

      // Calculate accuracy
      let totalAPE = 0, totalSE = 0, validCount = 0;
      for (const pred of forecast) {
        const actual = actualData.find(a => a.hour === pred.forecast_hour);
        if (actual && actual.actual_power_kw > 0) {
          const error = Math.abs(pred.predicted_power_kw - actual.actual_power_kw);
          totalAPE += (error / actual.actual_power_kw) * 100;
          totalSE += error * error;
          validCount++;
        }
      }

      const mape = validCount > 0 ? Math.round(totalAPE / validCount * 100) / 100 : null;
      const rmse = validCount > 0 ? Math.round(Math.sqrt(totalSE / validCount) * 100) / 100 : null;

      const forecastTotal = forecast.reduce((s, p) => s + (p.predicted_energy_kwh || 0), 0);
      const actualTotal = actualData.reduce((s, a) => s + (a.hourly_energy_kwh || 0), 0);

      trendDays.push({
        date,
        has_forecast: forecast.length > 0,
        has_actual: actualData.length > 0,
        forecast_total_kwh: Math.round(forecastTotal * 100) / 100,
        actual_total_kwh: Math.round(actualTotal * 100) / 100,
        mape,
        rmse,
        valid_comparison_hours: validCount,
      });
    }

    // Overall trend metrics
    const daysWithAccuracy = trendDays.filter(d => d.mape !== null);
    const avgMape = daysWithAccuracy.length > 0
      ? Math.round(daysWithAccuracy.reduce((s, d) => s + d.mape, 0) / daysWithAccuracy.length * 100) / 100
      : null;

    return {
      station: station.name,
      station_id: stationId,
      trend_days: trendDays,
      overall: {
        avg_mape: avgMape,
        days_analyzed: trendDays.length,
        days_with_data: daysWithAccuracy.length,
      },
    };
  },

  /* ============================================================
     6. STATION AGGREGATION
     ============================================================ */

  /**
   * Aggregate forecasts across multiple stations.
   */
  getAggregatedForecast(date, stationIds = null) {
    let stations;
    if (stationIds) {
      stations = stationIds.map(id => db.prepare('SELECT * FROM stations WHERE id = ?').get(id)).filter(Boolean);
    } else {
      stations = db.prepare("SELECT * FROM stations WHERE status = 'active'").all();
    }

    const stationForecasts = [];
    let totalEnergy = 0;
    const hourlyAgg = {};

    for (const station of stations) {
      const forecast = this.getEnhancedForecast(station.id, date, 'weighted_avg');
      if (!forecast) continue;

      stationForecasts.push({
        station_id: station.id,
        station_name: station.name,
        total_predicted_energy_kwh: forecast.total_predicted_energy_kwh,
        avg_confidence: forecast.avg_confidence,
      });
      totalEnergy += forecast.total_predicted_energy_kwh;

      // Aggregate hourly
      for (const pred of forecast.hourly_predictions) {
        const h = pred.forecast_hour;
        if (!hourlyAgg[h]) {
          hourlyAgg[h] = { hour: h, total_power_kw: 0, total_upper: 0, total_lower: 0, station_count: 0 };
        }
        hourlyAgg[h].total_power_kw += pred.predicted_power_kw;
        hourlyAgg[h].total_upper += (pred.confidence_upper || pred.predicted_power_kw * 1.15);
        hourlyAgg[h].total_lower += (pred.confidence_lower || pred.predicted_power_kw * 0.85);
        hourlyAgg[h].station_count++;
      }
    }

    const hourlyAggArray = Object.values(hourlyAgg)
      .sort((a, b) => a.hour - b.hour)
      .map(h => ({
        ...h,
        avg_power_kw: Math.round(h.total_power_kw * 100) / 100,
        avg_upper: Math.round(h.total_upper * 100) / 100,
        avg_lower: Math.round(h.total_lower * 100) / 100,
      }));

    return {
      date,
      station_count: stationForecasts.length,
      total_predicted_energy_kwh: Math.round(totalEnergy * 100) / 100,
      station_forecasts: stationForecasts,
      hourly_aggregate: hourlyAggArray,
    };
  },

  /* ============================================================
     7. DAILY SUMMARY
     ============================================================ */

  /**
   * Daily summary with total predicted energy and key metrics.
   */
  getDailySummary(stationId, date = null) {
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) throw new Error('Station not found');

    const forecastDate = date || new Date(Date.now() + 86400000).toISOString().split('T')[0];

    // Get forecasts for 3 days starting from forecastDate
    const days = [];
    for (let d = 0; d < 3; d++) {
      const dayDate = new Date(new Date(forecastDate).getTime() + d * 86400000).toISOString().split('T')[0];

      const baseline = db.prepare(`
        SELECT predicted_power_kw, predicted_energy_kwh, confidence
        FROM power_forecasts
        WHERE station_id = ? AND forecast_date = ? AND model_version LIKE 'baseline%'
        ORDER BY forecast_hour ASC
      `).all(stationId, dayDate);

      const weighted = db.prepare(`
        SELECT predicted_power_kw, predicted_energy_kwh, confidence
        FROM power_forecasts
        WHERE station_id = ? AND forecast_date = ? AND model_version = 'weighted_avg_v1'
        ORDER BY forecast_hour ASC
      `).all(stationId, dayDate);

      // Generate weighted_avg if missing
      let waPreds = weighted;
      if (waPreds.length === 0 && baseline.length > 0) {
        const result = this.generateWeightedAvgForecast(stationId, dayDate);
        waPreds = result.hourly_predictions;
      }

      const baselineTotal = baseline.reduce((s, p) => s + (p.predicted_energy_kwh || 0), 0);
      const waTotal = waPreds.reduce((s, p) => s + (p.predicted_energy_kwh || 0), 0);

      // Peak power hour
      const peakBaseline = baseline.length > 0
        ? baseline.reduce((max, p) => p.predicted_power_kw > max.predicted_power_kw ? p : max, baseline[0])
        : null;

      // Confidence
      const allPreds = waPreds.length > 0 ? waPreds : baseline;
      const avgConfidence = allPreds.length > 0
        ? Math.round(allPreds.reduce((s, p) => s + (p.confidence || 0), 0) / allPreds.length * 100) / 100
        : 0;

      days.push({
        date: dayDate,
        baseline_total_kwh: Math.round(baselineTotal * 100) / 100,
        weighted_avg_total_kwh: Math.round(waTotal * 100) / 100,
        peak_hour: peakBaseline ? peakBaseline.forecast_hour : null,
        peak_power_kw: peakBaseline ? peakBaseline.predicted_power_kw : 0,
        avg_confidence: avgConfidence,
        forecast_count: allPreds.length,
      });
    }

    return {
      station: station.name,
      station_id: stationId,
      generated_at: new Date().toISOString(),
      days,
    };
  },
};

module.exports = forecastEnhancedService;
