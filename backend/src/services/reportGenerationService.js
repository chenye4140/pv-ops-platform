/**
 * Report Generation Service — AI-powered daily/weekly/monthly/special reports
 *
 * Uses llmService.structuredOutput() and llmService.loadPrompt() to generate
 * structured JSON reports from real station data. All functions gracefully
 * degrade to mock/fallback results when the LLM API is not configured.
 *
 * Report types:
 *   - generateDailyReport(stationId, date)
 *   - generateWeeklyReport(stationId, endDate)
 *   - generateMonthlyReport(stationId, year, month)
 *   - generateSpecialReport(stationId, reportType, params)
 */

const { db } = require('../models/database');
const llmService = require('./llmService');

// ---------------------------------------------------------------------------
// Helpers — data queries
// ---------------------------------------------------------------------------

/**
 * Fetch station info by ID.
 * @param {number} stationId
 * @returns {object|null}
 */
function _getStation(stationId) {
  return db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
}

/**
 * Count modules and inverters for a station.
 * @param {number} stationId
 * @returns {{moduleCount: number, inverterCount: number}}
 */
function _getEquipmentCounts(stationId) {
  const inv = db.prepare(
    'SELECT COUNT(*) as count FROM inverters WHERE station_id = ?'
  ).get(stationId);
  const str = db.prepare(`
    SELECT COUNT(*) as count
    FROM strings s
    JOIN inverters i ON s.inverter_id = i.id
    WHERE i.station_id = ?
  `).get(stationId);
  return {
    inverterCount: inv ? inv.count : 0,
    moduleCount: str ? str.count : 0,
  };
}

/**
 * Format a date as YYYY-MM-DD.
 */
function _fmt(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Build a date range ISO string pair [start, end) for a given day.
 */
function _dayRange(dateStr) {
  const d = new Date(dateStr);
  d.setHours(0, 0, 0, 0);
  const start = d.toISOString();
  d.setDate(d.getDate() + 1);
  return [start, d.toISOString()];
}

/**
 * Build a date range for the past N days ending at endDateStr.
 */
function _multiDayRange(endDateStr, days) {
  const end = new Date(endDateStr);
  end.setHours(0, 0, 0, 0);
  const next = new Date(end);
  next.setDate(next.getDate() + 1);
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);
  return [start.toISOString(), next.toISOString()];
}

// ---------------------------------------------------------------------------
// Query: generation summary for a date range
// ---------------------------------------------------------------------------

/**
 * @param {number} stationId
 * @param {string} startISO
 * @param {string} endISO
 * @returns {object}
 */
function _queryGenerationSummary(stationId, startISO, endISO) {
  return db.prepare(`
    SELECT
      SUM(pd.power_w) * 0.25 / 1000 as total_energy_kwh,
      AVG(pd.power_w) / 1000 as avg_power_kw,
      MAX(pd.power_w) / 1000 as peak_power_kw,
      COUNT(*) as reading_count
    FROM power_data pd
    JOIN strings s ON pd.string_id = s.id
    JOIN inverters i ON s.inverter_id = i.id
    WHERE i.station_id = ? AND pd.timestamp >= ? AND pd.timestamp < ?
  `).get(stationId, startISO, endISO) || {};
}

/**
 * Daily generation breakdown for a multi-day range.
 * @returns {Array<{date, total_energy_kwh, avg_power_kw, peak_power_kw}>}
 */
function _queryDailyBreakdown(stationId, startISO, endISO) {
  return db.prepare(`
    SELECT
      DATE(pd.timestamp) as date,
      SUM(pd.power_w) * 0.25 / 1000 as total_energy_kwh,
      AVG(pd.power_w) / 1000 as avg_power_kw,
      MAX(pd.power_w) / 1000 as peak_power_kw
    FROM power_data pd
    JOIN strings s ON pd.string_id = s.id
    JOIN inverters i ON s.inverter_id = i.id
    WHERE i.station_id = ? AND pd.timestamp >= ? AND pd.timestamp < ?
    GROUP BY DATE(pd.timestamp)
    ORDER BY date ASC
  `).all(stationId, startISO, endISO);
}

// ---------------------------------------------------------------------------
// Query: weather summary
// ---------------------------------------------------------------------------

/**
 * @param {number} stationId
 * @param {string} startISO
 * @param {string} endISO
 * @returns {object}
 */
function _queryWeatherSummary(stationId, startISO, endISO) {
  return db.prepare(`
    SELECT
      AVG(irradiance_wm2) as avg_irradiance,
      MAX(irradiance_wm2) as peak_irradiance,
      AVG(temperature_c) as avg_temperature,
      AVG(wind_speed_ms) as avg_wind_speed
    FROM weather_data
    WHERE station_id = ? AND timestamp >= ? AND timestamp < ?
  `).get(stationId, startISO, endISO) || {};
}

// ---------------------------------------------------------------------------
// Query: alerts
// ---------------------------------------------------------------------------

/**
 * Alert counts grouped by severity for a date range.
 */
function _queryAlertsBySeverity(stationId, startISO, endISO) {
  const rows = db.prepare(`
    SELECT severity, COUNT(*) as count
    FROM alerts
    WHERE station_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY severity
  `).all(stationId, startISO, endISO);
  const map = {};
  rows.forEach(r => { map[r.severity] = r.count; });
  return map;
}

/**
 * Active alert detail (top 10).
 */
function _queryActiveAlerts(stationId) {
  return db.prepare(`
    SELECT id, severity, type, message, created_at
    FROM alerts WHERE station_id = ? AND status = 'active'
    ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END
    LIMIT 10
  `).all(stationId);
}

/**
 * Alert count by type for a date range.
 */
function _queryAlertsByType(stationId, startISO, endISO) {
  return db.prepare(`
    SELECT type, COUNT(*) as count
    FROM alerts
    WHERE station_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY type
    ORDER BY count DESC
  `).all(stationId, startISO, endISO);
}

// ---------------------------------------------------------------------------
// Query: work orders
// ---------------------------------------------------------------------------

/**
 * Work order stats grouped by status for a date range.
 */
function _queryWorkOrdersByStatus(stationId, startISO, endISO) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM work_orders
    WHERE station_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY status
  `).all(stationId, startISO, endISO);
  const map = {};
  rows.forEach(r => { map[r.status] = r.count; });
  return map;
}

/**
 * Work order stats grouped by type for a date range.
 */
function _queryWorkOrdersByType(stationId, startISO, endISO) {
  return db.prepare(`
    SELECT type, COUNT(*) as count
    FROM work_orders
    WHERE station_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY type
    ORDER BY count DESC
  `).all(stationId, startISO, endISO);
}

// ---------------------------------------------------------------------------
// Query: inverter / string status
// ---------------------------------------------------------------------------

function _queryInverterStatus(stationId) {
  return db.prepare(`
    SELECT status, COUNT(*) as count
    FROM inverters WHERE station_id = ?
    GROUP BY status
  `).all(stationId);
}

function _queryStringStatus(stationId) {
  return db.prepare(`
    SELECT s.status, COUNT(*) as count
    FROM strings s
    JOIN inverters i ON s.inverter_id = i.id
    WHERE i.station_id = ?
    GROUP BY s.status
  `).all(stationId);
}

// ---------------------------------------------------------------------------
// PR calculation helper
// ---------------------------------------------------------------------------

/**
 * Calculate PR for a single day.
 * @param {number} stationId
 * @param {string} dateStr  YYYY-MM-DD
 * @returns {number} PR percentage
 */
function _calcPR(stationId, dateStr) {
  const kpiService = require('./kpiService');
  const result = kpiService.calculatePR(stationId, dateStr);
  if (!result) return 0;
  return result.pr || 0;
}

// ---------------------------------------------------------------------------
// 1. generateDailyReport
// ---------------------------------------------------------------------------

/**
 * Generate an enhanced daily report for a PV station.
 *
 * Queries generation data, weather, alerts, work orders, equipment status
 * for the specified date, then uses llmService to produce a structured
 * JSON report with executive summary, sections, findings, and recommendations.
 *
 * @param {number} stationId
 * @param {string} [date]  — ISO date string (YYYY-MM-DD). Defaults to latest data date.
 * @returns {Promise<object>} Structured daily report
 */
async function generateDailyReport(stationId, date) {
  const station = _getStation(stationId);
  if (!station) {
    throw new Error(`Station ${stationId} not found`);
  }

  // Resolve date: use provided date or latest available data date
  let targetDate;
  if (date) {
    targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
  } else {
    const latestTs = db.prepare(`
      SELECT MAX(pd.timestamp) as ts FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ?
    `).get(stationId);
    targetDate = latestTs && latestTs.ts ? new Date(latestTs.ts) : new Date();
    targetDate.setHours(0, 0, 0, 0);
  }

  const dateStr = _fmt(targetDate);
  const [startISO, endISO] = _dayRange(dateStr);
  const capacityKW = station.capacity_mw * 1000;
  const equip = _getEquipmentCounts(stationId);

  // Gather data
  const gen = _queryGenerationSummary(stationId, startISO, endISO);
  const weather = _queryWeatherSummary(stationId, startISO, endISO);
  const alertsBySeverity = _queryAlertsBySeverity(stationId, startISO, endISO);
  const activeAlerts = _queryActiveAlerts(stationId);
  const woByStatus = _queryWorkOrdersByStatus(stationId, startISO, endISO);
  const woByType = _queryWorkOrdersByType(stationId, startISO, endISO);
  const pr = _calcPR(stationId, dateStr);
  const totalEnergy = gen.total_energy_kwh || 0;

  // Build generation data text
  const generationData = [
    `- 日期: ${dateStr}`,
    `- 总发电量: ${(totalEnergy).toFixed(1)} kWh`,
    `- 平均功率: ${(gen.avg_power_kw || 0).toFixed(1)} kW`,
    `- 峰值功率: ${(gen.peak_power_kw || 0).toFixed(1)} kW`,
    `- 有效读数: ${gen.reading_count || 0} 条`,
    `- 性能比 PR: ${pr}%`,
  ].join('\n');

  // Equipment data text
  const invStatus = _queryInverterStatus(stationId);
  const strStatus = _queryStringStatus(stationId);
  const equipmentData = [
    `- 逆变器数量: ${equip.inverterCount} 台`,
    `- 组串数量: ${equip.moduleCount} 个`,
    `- 逆变器状态: ${invStatus.map(r => `${r.status}=${r.count}`).join(', ') || '无数据'}`,
    `- 组串状态: ${strStatus.map(r => `${r.status}=${r.count}`).join(', ') || '无数据'}`,
  ].join('\n');

  // Alert stats text
  const alertStats = [
    `- 当日告警总数: ${Object.values(alertsBySeverity).reduce((a, b) => a + b, 0)}`,
    `- 严重: ${alertsBySeverity.critical || 0}条`,
    `- 警告: ${alertsBySeverity.warning || 0}条`,
    `- 提示: ${alertsBySeverity.info || 0}条`,
    activeAlerts.length > 0 ? `- 活跃告警: ${activeAlerts.slice(0, 5).map(a => `[${a.severity}]${a.type}: ${a.message}`).join('; ')}` : '',
  ].filter(Boolean).join('\n');

  // Work order stats text
  const workorderStats = [
    `- 工单状态: ${Object.entries(woByStatus).map(([k, v]) => `${k}=${v}`).join(', ') || '无数据'}`,
    `- 工单类型: ${woByType.map(r => `${r.type}=${r.count}`).join(', ') || '无数据'}`,
  ].join('\n');

  // Weather data text
  const weatherData = [
    `- 平均辐照度: ${(weather.avg_irradiance || 0).toFixed(1)} W/m²`,
    `- 峰值辐照度: ${(weather.peak_irradiance || 0).toFixed(1)} W/m²`,
    `- 平均温度: ${(weather.avg_temperature || 0).toFixed(1)}°C`,
    `- 平均风速: ${(weather.avg_wind_speed || 0).toFixed(1)} m/s`,
  ].join('\n');

  const context = {
    reportType: 'daily',
    reportPeriod: dateStr,
    stationName: station.name,
    capacityMW: station.capacity_mw,
    stationLocation: station.location,
    moduleCount: equip.moduleCount,
    inverterCount: equip.inverterCount,
    generationData,
    equipmentData,
    alertStats,
    workorderStats,
    weatherData,
    sparePartsData: '无数据',
  };

  try {
    const prompt = llmService.loadPrompt('report-generation.md', context);

    const result = await llmService.structuredOutput({
      prompt,
      systemPrompt: '你是光伏电站运维报告生成专家。请根据提供的数据生成结构化JSON报告。',
      maxTokens: 4096,
      temperature: 0.1,
      retries: 2,
    });

    return {
      success: true,
      reportType: 'daily',
      date: dateStr,
      station: {
        id: station.id,
        name: station.name,
        capacity_mw: station.capacity_mw,
      },
      data: {
        generation: {
          total_energy_kwh: Math.round(totalEnergy * 100) / 100,
          avg_power_kw: Math.round((gen.avg_power_kw || 0) * 100) / 100,
          peak_power_kw: Math.round((gen.peak_power_kw || 0) * 100) / 100,
          performance_ratio: pr,
        },
        weather: {
          avg_irradiance_wm2: Math.round((weather.avg_irradiance || 0) * 10) / 10,
          peak_irradiance_wm2: Math.round((weather.peak_irradiance || 0) * 10) / 10,
          avg_temperature_c: Math.round((weather.avg_temperature || 0) * 10) / 10,
          avg_wind_speed_ms: Math.round((weather.avg_wind_speed || 0) * 10) / 10,
        },
        alerts: {
          by_severity: {
            critical: alertsBySeverity.critical || 0,
            warning: alertsBySeverity.warning || 0,
            info: alertsBySeverity.info || 0,
          },
          active_list: activeAlerts,
        },
        work_orders: {
          by_status: woByStatus,
          by_type: woByType,
        },
      },
      ai_report: result.data,
      ai_model: result.model,
    };
  } catch (error) {
    console.error('[Report Service] Daily report LLM failed, returning data only:', error.message);
    // Fallback: return raw data without AI-generated report
    return {
      success: true,
      reportType: 'daily',
      date: dateStr,
      station: {
        id: station.id,
        name: station.name,
        capacity_mw: station.capacity_mw,
      },
      data: {
        generation: {
          total_energy_kwh: Math.round(totalEnergy * 100) / 100,
          avg_power_kw: Math.round((gen.avg_power_kw || 0) * 100) / 100,
          peak_power_kw: Math.round((gen.peak_power_kw || 0) * 100) / 100,
          performance_ratio: pr,
        },
        weather: {
          avg_irradiance_wm2: Math.round((weather.avg_irradiance || 0) * 10) / 10,
          peak_irradiance_wm2: Math.round((weather.peak_irradiance || 0) * 10) / 10,
          avg_temperature_c: Math.round((weather.avg_temperature || 0) * 10) / 10,
          avg_wind_speed_ms: Math.round((weather.avg_wind_speed || 0) * 10) / 10,
        },
        alerts: {
          by_severity: {
            critical: alertsBySeverity.critical || 0,
            warning: alertsBySeverity.warning || 0,
            info: alertsBySeverity.info || 0,
          },
          active_list: activeAlerts,
        },
        work_orders: {
          by_status: woByStatus,
          by_type: woByType,
        },
      },
      ai_report: null,
      ai_model: 'fallback',
      error: 'LLM generation failed, returning raw data only',
    };
  }
}

// ---------------------------------------------------------------------------
// 2. generateWeeklyReport
// ---------------------------------------------------------------------------

/**
 * Generate a weekly report covering the 7 days ending at endDate.
 *
 * Includes 7-day generation trend, alert statistics by type/severity/day,
 * work order statistics by status/type, health score trend, and LLM-generated
 * weekly summary.
 *
 * @param {number} stationId
 * @param {string} [endDate] — ISO date string (YYYY-MM-DD). Defaults to today.
 * @returns {Promise<object>} Structured weekly report
 */
async function generateWeeklyReport(stationId, endDate) {
  const station = _getStation(stationId);
  if (!station) {
    throw new Error(`Station ${stationId} not found`);
  }

  const end = endDate ? new Date(endDate) : new Date();
  end.setHours(0, 0, 0, 0);
  const endDateStr = _fmt(end);
  const [startISO, endISO] = _multiDayRange(endDateStr, 7);
  const capacityKW = station.capacity_mw * 1000;
  const equip = _getEquipmentCounts(stationId);

  // 7-day generation trend
  const dailyBreakdown = _queryDailyBreakdown(stationId, startISO, endISO);
  // Fill missing days with zeros
  const trendData = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(end);
    d.setDate(d.getDate() - 6 + i);
    const ds = _fmt(d);
    const found = dailyBreakdown.find(r => r.date === ds);
    trendData.push({
      date: ds,
      total_energy_kwh: found ? Math.round(found.total_energy_kwh * 100) / 100 : 0,
      avg_power_kw: found ? Math.round(found.avg_power_kw * 100) / 100 : 0,
      peak_power_kw: found ? Math.round(found.peak_power_kw * 100) / 100 : 0,
    });
  }

  // Weekly summary
  const weeklyGen = _queryGenerationSummary(stationId, startISO, endISO);
  const totalEnergy = weeklyGen.total_energy_kwh || 0;

  // Alerts by severity for the week
  const alertsBySeverity = _queryAlertsBySeverity(stationId, startISO, endISO);
  const alertsByType = _queryAlertsByType(stationId, startISO, endISO);

  // Work orders
  const woByStatus = _queryWorkOrdersByStatus(stationId, startISO, endISO);
  const woByType = _queryWorkOrdersByType(stationId, startISO, endISO);

  // Health scores for the week (sample: today + 3 days ago + 6 days ago)
  const healthScores = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(end);
    d.setDate(d.getDate() - 6 + i);
    // Health score is based on current state, so use a snapshot approach
    const ds = _fmt(d);
    const healthService = require('./healthScoreService');
    const score = healthService.getStationHealthScore(stationId);
    if (score) {
      healthScores.push({ date: ds, score: score.score, grade: score.grade });
    }
  }
  // Deduplicate (health score is same each call since it's current state)
  const uniqueHealth = healthScores.filter((v, i, a) => a.findIndex(t => t.date === v.date) === i);
  // Use only current score with week label
  const currentHealth = healthService.getStationHealthScore(stationId);

  // Day-over-day comparison (first vs last 3 days)
  const first3 = trendData.slice(0, 3).reduce((s, d) => s + d.total_energy_kwh, 0);
  const last3 = trendData.slice(-3).reduce((s, d) => s + d.total_energy_kwh, 0);
  const dodChange = first3 > 0 ? (((last3 - first3) / first3) * 100).toFixed(1) : 'N/A';

  // Weekly PR (average of daily PRs)
  let weeklyPR = 0;
  let prCount = 0;
  for (const item of trendData) {
    if (item.total_energy_kwh > 0) {
      weeklyPR += _calcPR(stationId, item.date);
      prCount++;
    }
  }
  weeklyPR = prCount > 0 ? Math.round((weeklyPR / prCount) * 10) / 10 : 0;

  // Weather summary for the week
  const weather = _queryWeatherSummary(stationId, startISO, endISO);

  // Build text for LLM
  const generationData = [
    `- 报告周期: ${trendData[0].date} 至 ${trendData[6].date}`,
    `- 周总发电量: ${totalEnergy.toFixed(1)} kWh`,
    `- 日均发电量: ${(totalEnergy / 7).toFixed(1)} kWh`,
    `- 周平均PR: ${weeklyPR}%`,
    `- 前3天总发电: ${first3.toFixed(1)} kWh`,
    `- 后3天总发电: ${last3.toFixed(1)} kWh`,
    `- 环比变化: ${dodChange}%`,
    `- 每日发电趋势:`,
    ...trendData.map(d => `    ${d.date}: ${d.total_energy_kwh.toFixed(1)} kWh (峰值 ${d.peak_power_kw.toFixed(1)} kW)`),
  ].join('\n');

  const alertStats = [
    `- 本周告警总数: ${Object.values(alertsBySeverity).reduce((a, b) => a + b, 0)}`,
    `- 严重: ${alertsBySeverity.critical || 0}条`,
    `- 警告: ${alertsBySeverity.warning || 0}条`,
    `- 提示: ${alertsBySeverity.info || 0}条`,
    `- 告警类型分布: ${alertsByType.map(r => `${r.type}=${r.count}`).join(', ') || '无数据'}`,
  ].join('\n');

  const workorderStats = [
    `- 工单状态: ${Object.entries(woByStatus).map(([k, v]) => `${k}=${v}`).join(', ') || '无数据'}`,
    `- 工单类型: ${woByType.map(r => `${r.type}=${r.count}`).join(', ') || '无数据'}`,
  ].join('\n');

  const equipmentData = [
    `- 逆变器数量: ${equip.inverterCount} 台`,
    `- 组串数量: ${equip.moduleCount} 个`,
    `- 当前健康评分: ${currentHealth ? currentHealth.score : 'N/A'} (${currentHealth ? currentHealth.grade : 'N/A'})`,
  ].join('\n');

  const weatherData = [
    `- 周平均辐照度: ${(weather.avg_irradiance || 0).toFixed(1)} W/m²`,
    `- 周峰值辐照度: ${(weather.peak_irradiance || 0).toFixed(1)} W/m²`,
    `- 周平均温度: ${(weather.avg_temperature || 0).toFixed(1)}°C`,
    `- 周平均风速: ${(weather.avg_wind_speed || 0).toFixed(1)} m/s`,
  ].join('\n');

  const context = {
    reportType: 'weekly',
    reportPeriod: `${trendData[0].date} 至 ${trendData[6].date}`,
    stationName: station.name,
    capacityMW: station.capacity_mw,
    stationLocation: station.location,
    moduleCount: equip.moduleCount,
    inverterCount: equip.inverterCount,
    generationData,
    equipmentData,
    alertStats,
    workorderStats,
    weatherData,
    sparePartsData: '无数据',
  };

  try {
    const prompt = llmService.loadPrompt('report-generation.md', context);

    const result = await llmService.structuredOutput({
      prompt,
      systemPrompt: '你是光伏电站运维报告生成专家。请根据提供的周数据生成结构化JSON周报。',
      maxTokens: 4096,
      temperature: 0.1,
      retries: 2,
    });

    return {
      success: true,
      reportType: 'weekly',
      period: `${trendData[0].date} 至 ${trendData[6].date}`,
      station: {
        id: station.id,
        name: station.name,
        capacity_mw: station.capacity_mw,
      },
      data: {
        generation: {
          total_energy_kwh: Math.round(totalEnergy * 100) / 100,
          daily_average_kwh: Math.round((totalEnergy / 7) * 100) / 100,
          trend: trendData,
          performance_ratio: weeklyPR,
          day_over_day_change: `${dodChange}%`,
        },
        alerts: {
          by_severity: {
            critical: alertsBySeverity.critical || 0,
            warning: alertsBySeverity.warning || 0,
            info: alertsBySeverity.info || 0,
          },
          by_type: alertsByType,
        },
        work_orders: {
          by_status: woByStatus,
          by_type: woByType,
        },
        health_score: currentHealth ? {
          score: currentHealth.score,
          grade: currentHealth.grade,
        } : null,
      },
      ai_report: result.data,
      ai_model: result.model,
    };
  } catch (error) {
    console.error('[Report Service] Weekly report LLM failed, returning data only:', error.message);
    return {
      success: true,
      reportType: 'weekly',
      period: `${trendData[0].date} 至 ${trendData[6].date}`,
      station: {
        id: station.id,
        name: station.name,
        capacity_mw: station.capacity_mw,
      },
      data: {
        generation: {
          total_energy_kwh: Math.round(totalEnergy * 100) / 100,
          daily_average_kwh: Math.round((totalEnergy / 7) * 100) / 100,
          trend: trendData,
          performance_ratio: weeklyPR,
          day_over_day_change: `${dodChange}%`,
        },
        alerts: {
          by_severity: {
            critical: alertsBySeverity.critical || 0,
            warning: alertsBySeverity.warning || 0,
            info: alertsBySeverity.info || 0,
          },
          by_type: alertsByType,
        },
        work_orders: {
          by_status: woByStatus,
          by_type: woByType,
        },
        health_score: currentHealth ? {
          score: currentHealth.score,
          grade: currentHealth.grade,
        } : null,
      },
      ai_report: null,
      ai_model: 'fallback',
      error: 'LLM generation failed, returning raw data only',
    };
  }
}

// ---------------------------------------------------------------------------
// 3. generateMonthlyReport
// ---------------------------------------------------------------------------

/**
 * Generate a monthly report for a PV station.
 *
 * Includes monthly generation statistics, PR trend analysis, equipment
 * health trends, major event review, and LLM-generated monthly summary.
 *
 * @param {number} stationId
 * @param {number} [year]  — e.g. 2025. Defaults to current year.
 * @param {number} [month] — 1-12. Defaults to current month.
 * @returns {Promise<object>} Structured monthly report
 */
async function generateMonthlyReport(stationId, year, month) {
  const station = _getStation(stationId);
  if (!station) {
    throw new Error(`Station ${stationId} not found`);
  }

  const now = new Date();
  const targetYear = year || now.getFullYear();
  const targetMonth = month || now.getMonth() + 1; // JS months are 0-indexed

  const monthStart = new Date(targetYear, targetMonth - 1, 1);
  monthStart.setHours(0, 0, 0, 0);
  const monthEnd = new Date(targetYear, targetMonth, 1);
  monthEnd.setHours(0, 0, 0, 0);
  const startISO = monthStart.toISOString();
  const endISO = monthEnd.toISOString();
  const periodStr = `${targetYear}年${targetMonth}月`;

  const capacityKW = station.capacity_mw * 1000;
  const equip = _getEquipmentCounts(stationId);

  // Monthly generation summary
  const monthlyGen = _queryGenerationSummary(stationId, startISO, endISO);
  const totalEnergy = monthlyGen.total_energy_kwh || 0;

  // Daily breakdown for PR trend
  const dailyBreakdown = _queryDailyBreakdown(stationId, startISO, endISO);

  // PR for each day with data
  const prTrend = [];
  let totalPR = 0;
  let prCount = 0;
  for (const item of dailyBreakdown) {
    if (item.total_energy_kwh > 0) {
      const pr = _calcPR(stationId, item.date);
      prTrend.push({ date: item.date, pr, energy_kwh: Math.round(item.total_energy_kwh * 100) / 100 });
      totalPR += pr;
      prCount++;
    }
  }
  const avgPR = prCount > 0 ? Math.round((totalPR / prCount) * 10) / 10 : 0;

  // Alerts for the month
  const alertsBySeverity = _queryAlertsBySeverity(stationId, startISO, endISO);
  const alertsByType = _queryAlertsByType(stationId, startISO, endISO);

  // Work orders for the month
  const woByStatus = _queryWorkOrdersByStatus(stationId, startISO, endISO);
  const woByType = _queryWorkOrdersByType(stationId, startISO, endISO);

  // Weather for the month
  const weather = _queryWeatherSummary(stationId, startISO, endISO);

  // Equipment status
  const invStatus = _queryInverterStatus(stationId);
  const strStatus = _queryStringStatus(stationId);

  // Major events: count of critical alerts and completed work orders
  const criticalAlerts = db.prepare(`
    SELECT id, type, message, created_at
    FROM alerts
    WHERE station_id = ? AND severity = 'critical' AND created_at >= ? AND created_at < ?
    ORDER BY created_at ASC
    LIMIT 20
  `).all(stationId, startISO, endISO);

  const completedWOs = db.prepare(`
    SELECT id, title, type, completed_at
    FROM work_orders
    WHERE station_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?
    ORDER BY completed_at ASC
    LIMIT 20
  `).all(stationId, startISO, endISO);

  // Month-over-month comparison (previous month)
  const prevMonthEnd = new Date(monthStart);
  const prevMonthStart = new Date(monthStart);
  prevMonthStart.setMonth(prevMonthStart.getMonth() - 1);
  const prevGen = _queryGenerationSummary(
    stationId,
    prevMonthStart.toISOString(),
    prevMonthEnd.toISOString()
  );
  const prevEnergy = prevGen.total_energy_kwh || 0;
  const momChange = prevEnergy > 0
    ? (((totalEnergy - prevEnergy) / prevEnergy) * 100).toFixed(1)
    : 'N/A';

  // Build text for LLM
  const generationData = [
    `- 报告期间: ${periodStr}`,
    `- 月总发电量: ${totalEnergy.toFixed(1)} kWh`,
    `- 日均发电量: ${dailyBreakdown.length > 0 ? (totalEnergy / dailyBreakdown.length).toFixed(1) : 0} kWh`,
    `- 月平均PR: ${avgPR}%`,
    `- 上月发电量: ${prevEnergy.toFixed(1)} kWh`,
    `- 环比变化: ${momChange}%`,
    `- 峰值功率: ${(monthlyGen.peak_power_kw || 0).toFixed(1)} kW`,
    `- 有效发电天数: ${dailyBreakdown.length} 天`,
  ].join('\n');

  const prTrendText = prTrend.length > 0
    ? `- PR趋势: ${prTrend.map(p => `${p.date}=${p.pr}%`).join(', ')}`
    : '- PR趋势: 无数据';

  const equipmentData = [
    `- 逆变器数量: ${equip.inverterCount} 台`,
    `- 组串数量: ${equip.moduleCount} 个`,
    `- 逆变器状态: ${invStatus.map(r => `${r.status}=${r.count}`).join(', ') || '无数据'}`,
    `- 组串状态: ${strStatus.map(r => `${r.status}=${r.count}`).join(', ') || '无数据'}`,
    prTrendText,
  ].join('\n');

  const alertStats = [
    `- 本月告警总数: ${Object.values(alertsBySeverity).reduce((a, b) => a + b, 0)}`,
    `- 严重: ${alertsBySeverity.critical || 0}条`,
    `- 警告: ${alertsBySeverity.warning || 0}条`,
    `- 提示: ${alertsBySeverity.info || 0}条`,
    `- 告警类型分布: ${alertsByType.map(r => `${r.type}=${r.count}`).join(', ') || '无数据'}`,
    criticalAlerts.length > 0
      ? `- 重大告警(${criticalAlerts.length}条): ${criticalAlerts.slice(0, 5).map(a => `[${a.type}] ${a.message}`).join('; ')}`
      : '',
  ].filter(Boolean).join('\n');

  const workorderStats = [
    `- 工单状态: ${Object.entries(woByStatus).map(([k, v]) => `${k}=${v}`).join(', ') || '无数据'}`,
    `- 工单类型: ${woByType.map(r => `${r.type}=${r.count}`).join(', ') || '无数据'}`,
    completedWOs.length > 0
      ? `- 已完成工单(${completedWOs.length}个): ${completedWOs.slice(0, 5).map(w => `[${w.type}] ${w.title}`).join('; ')}`
      : '',
  ].filter(Boolean).join('\n');

  const weatherData = [
    `- 月平均辐照度: ${(weather.avg_irradiance || 0).toFixed(1)} W/m²`,
    `- 月峰值辐照度: ${(weather.peak_irradiance || 0).toFixed(1)} W/m²`,
    `- 月平均温度: ${(weather.avg_temperature || 0).toFixed(1)}°C`,
    `- 月平均风速: ${(weather.avg_wind_speed || 0).toFixed(1)} m/s`,
  ].join('\n');

  const context = {
    reportType: 'monthly',
    reportPeriod: periodStr,
    stationName: station.name,
    capacityMW: station.capacity_mw,
    stationLocation: station.location,
    moduleCount: equip.moduleCount,
    inverterCount: equip.inverterCount,
    generationData,
    equipmentData,
    alertStats,
    workorderStats,
    weatherData,
    sparePartsData: '无数据',
  };

  try {
    const prompt = llmService.loadPrompt('report-generation.md', context);

    const result = await llmService.structuredOutput({
      prompt,
      systemPrompt: '你是光伏电站运维报告生成专家。请根据提供的月度数据生成结构化JSON月报。',
      maxTokens: 4096,
      temperature: 0.1,
      retries: 2,
    });

    return {
      success: true,
      reportType: 'monthly',
      period: periodStr,
      station: {
        id: station.id,
        name: station.name,
        capacity_mw: station.capacity_mw,
      },
      data: {
        generation: {
          total_energy_kwh: Math.round(totalEnergy * 100) / 100,
          daily_average_kwh: dailyBreakdown.length > 0
            ? Math.round((totalEnergy / dailyBreakdown.length) * 100) / 100
            : 0,
          performance_ratio: avgPR,
          pr_trend: prTrend.slice(0, 31),
          mom_change: `${momChange}%`,
          peak_power_kw: Math.round((monthlyGen.peak_power_kw || 0) * 100) / 100,
        },
        alerts: {
          by_severity: {
            critical: alertsBySeverity.critical || 0,
            warning: alertsBySeverity.warning || 0,
            info: alertsBySeverity.info || 0,
          },
          by_type: alertsByType,
          critical_list: criticalAlerts.slice(0, 10),
        },
        work_orders: {
          by_status: woByStatus,
          by_type: woByType,
          completed_list: completedWOs.slice(0, 10),
        },
        weather: {
          avg_irradiance_wm2: Math.round((weather.avg_irradiance || 0) * 10) / 10,
          peak_irradiance_wm2: Math.round((weather.peak_irradiance || 0) * 10) / 10,
          avg_temperature_c: Math.round((weather.avg_temperature || 0) * 10) / 10,
          avg_wind_speed_ms: Math.round((weather.avg_wind_speed || 0) * 10) / 10,
        },
      },
      ai_report: result.data,
      ai_model: result.model,
    };
  } catch (error) {
    console.error('[Report Service] Monthly report LLM failed, returning data only:', error.message);
    return {
      success: true,
      reportType: 'monthly',
      period: periodStr,
      station: {
        id: station.id,
        name: station.name,
        capacity_mw: station.capacity_mw,
      },
      data: {
        generation: {
          total_energy_kwh: Math.round(totalEnergy * 100) / 100,
          daily_average_kwh: dailyBreakdown.length > 0
            ? Math.round((totalEnergy / dailyBreakdown.length) * 100) / 100
            : 0,
          performance_ratio: avgPR,
          pr_trend: prTrend.slice(0, 31),
          mom_change: `${momChange}%`,
          peak_power_kw: Math.round((monthlyGen.peak_power_kw || 0) * 100) / 100,
        },
        alerts: {
          by_severity: {
            critical: alertsBySeverity.critical || 0,
            warning: alertsBySeverity.warning || 0,
            info: alertsBySeverity.info || 0,
          },
          by_type: alertsByType,
          critical_list: criticalAlerts.slice(0, 10),
        },
        work_orders: {
          by_status: woByStatus,
          by_type: woByType,
          completed_list: completedWOs.slice(0, 10),
        },
        weather: {
          avg_irradiance_wm2: Math.round((weather.avg_irradiance || 0) * 10) / 10,
          peak_irradiance_wm2: Math.round((weather.peak_irradiance || 0) * 10) / 10,
          avg_temperature_c: Math.round((weather.avg_temperature || 0) * 10) / 10,
          avg_wind_speed_ms: Math.round((weather.avg_wind_speed || 0) * 10) / 10,
        },
      },
      ai_report: null,
      ai_model: 'fallback',
      error: 'LLM generation failed, returning raw data only',
    };
  }
}

// ---------------------------------------------------------------------------
// 4. generateSpecialReport
// ---------------------------------------------------------------------------

/**
 * Generate a special-purpose report for a PV station.
 *
 * Supported reportType values:
 *   - 'anomaly'      — 异常分析报告：分析指定期间内的异常/告警
 *   - 'maintenance'  — 维护效果评估：评估工单和维护活动的效果
 *   - 'comparison'   — 设备性能对比：对比逆变器/组串的性能
 *
 * @param {number} stationId
 * @param {string} reportType  — 'anomaly' | 'maintenance' | 'comparison'
 * @param {object} [params]    — Optional parameters (startDate, endDate, etc.)
 * @returns {Promise<object>} Structured special report
 */
async function generateSpecialReport(stationId, reportType, params = {}) {
  const validTypes = ['anomaly', 'maintenance', 'comparison'];
  if (!validTypes.includes(reportType)) {
    throw new Error(`Invalid reportType: ${reportType}. Must be one of: ${validTypes.join(', ')}`);
  }

  const station = _getStation(stationId);
  if (!station) {
    throw new Error(`Station ${stationId} not found`);
  }

  // Resolve date range
  const endDate = params.endDate ? new Date(params.endDate) : new Date();
  endDate.setHours(0, 0, 0, 0);
  const days = params.days || 7;
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days + 1);
  startDate.setHours(0, 0, 0, 0);
  const startISO = startDate.toISOString();
  const endISO = endDate.toISOString();
  const periodStr = `${_fmt(startDate)} 至 ${_fmt(endDate)}`;

  const equip = _getEquipmentCounts(stationId);

  let generationData = '';
  let equipmentData = '';
  let alertStats = '';
  let workorderStats = '';
  let weatherData = '无数据';
  let reportTitle = '';
  let reportTypeLabel = '';

  // Gather data specific to each report type
  switch (reportType) {
    case 'anomaly': {
      reportTitle = '异常分析报告';
      reportTypeLabel = 'anomaly';

      const alertsBySeverity = _queryAlertsBySeverity(stationId, startISO, endISO);
      const alertsByType = _queryAlertsByType(stationId, startISO, endISO);
      const criticalAlerts = db.prepare(`
        SELECT id, severity, type, message, created_at, status
        FROM alerts
        WHERE station_id = ? AND created_at >= ? AND created_at < ?
        ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, created_at DESC
        LIMIT 30
      `).all(stationId, startISO, endISO);

      // Daily alert count trend
      const dailyAlerts = db.prepare(`
        SELECT DATE(created_at) as date, COUNT(*) as count,
          SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical_count,
          SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) as warning_count
        FROM alerts
        WHERE station_id = ? AND created_at >= ? AND created_at < ?
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `).all(stationId, startISO, endISO);

      generationData = [
        `- 分析期间: ${periodStr}`,
        `- 告警总数: ${Object.values(alertsBySeverity).reduce((a, b) => a + b, 0)}`,
        `- 告警趋势:`,
        ...dailyAlerts.map(d => `    ${d.date}: 总计${d.count}条 (严重${d.critical_count || 0}, 警告${d.warning_count || 0})`),
      ].join('\n');

      equipmentData = [
        `- 逆变器: ${equip.inverterCount} 台`,
        `- 组串: ${equip.moduleCount} 个`,
      ].join('\n');

      alertStats = [
        `- 严重告警: ${alertsBySeverity.critical || 0}条`,
        `- 警告告警: ${alertsBySeverity.warning || 0}条`,
        `- 提示告警: ${alertsBySeverity.info || 0}条`,
        `- 告警类型分布: ${alertsByType.map(r => `${r.type}=${r.count}`).join(', ') || '无'}`,
        `- 关键告警详情(${criticalAlerts.length}条):`,
        ...criticalAlerts.slice(0, 10).map(a => `    [${a.severity}] ${a.type}: ${a.message} (${_fmt(new Date(a.created_at))}, ${a.status})`),
      ].join('\n');

      workorderStats = '本报告中工单数据为辅助参考，详见维护效果评估报告';
      break;
    }

    case 'maintenance': {
      reportTitle = '维护效果评估报告';
      reportTypeLabel = 'maintenance';

      const woByStatus = _queryWorkOrdersByStatus(stationId, startISO, endISO);
      const woByType = _queryWorkOrdersByType(stationId, startISO, endISO);

      const completedWOs = db.prepare(`
        SELECT id, title, type, priority, completed_at,
          julianday(completed_at) - julianday(created_at) as duration_days
        FROM work_orders
        WHERE station_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?
        ORDER BY completed_at DESC
        LIMIT 20
      `).all(stationId, startISO, endISO);

      const pendingWOs = db.prepare(`
        SELECT id, title, type, priority, created_at,
          julianday('now') - julianday(created_at) as pending_days
        FROM work_orders
        WHERE station_id = ? AND status IN ('pending', 'in_progress') AND created_at < ?
        ORDER BY created_at ASC
        LIMIT 20
      `).all(stationId, startISO, endISO);

      // Average completion time
      let avgDuration = 0;
      if (completedWOs.length > 0) {
        const totalDays = completedWOs.reduce((s, w) => s + (w.duration_days || 0), 0);
        avgDuration = Math.round((totalDays / completedWOs.length) * 10) / 10;
      }

      // Pre/post maintenance energy comparison
      const gen = _queryGenerationSummary(stationId, startISO, endISO);

      generationData = [
        `- 评估期间: ${periodStr}`,
        `- 期间总发电量: ${(gen.total_energy_kwh || 0).toFixed(1)} kWh`,
        `- 完成工单数: ${completedWOs.length}`,
        `- 平均处理时长: ${avgDuration} 天`,
      ].join('\n');

      equipmentData = [
        `- 逆变器: ${equip.inverterCount} 台`,
        `- 组串: ${equip.moduleCount} 个`,
      ].join('\n');

      alertStats = '本报告中告警数据为辅助参考，详见异常分析报告';

      workorderStats = [
        `- 工单状态: ${Object.entries(woByStatus).map(([k, v]) => `${k}=${v}`).join(', ') || '无数据'}`,
        `- 工单类型: ${woByType.map(r => `${r.type}=${r.count}`).join(', ') || '无数据'}`,
        `- 已完成工单(${completedWOs.length}个):`,
        ...completedWOs.slice(0, 10).map(w => `    [${w.type}] ${w.title} (耗时${(w.duration_days || 0).toFixed(1)}天)`),
        pendingWOs.length > 0
          ? `- 待处理工单(${pendingWOs.length}个):`
          : '',
        ...pendingWOs.slice(0, 5).map(w => `    [${w.type}] ${w.title} (已等待${(w.pending_days || 0).toFixed(1)}天)`),
      ].filter(Boolean).join('\n');
      break;
    }

    case 'comparison': {
      reportTitle = '设备性能对比报告';
      reportTypeLabel = 'comparison';

      // Inverter-level comparison
      const inverters = db.prepare(
        'SELECT id, name, model, rated_power_kw, status FROM inverters WHERE station_id = ?'
      ).all(stationId);

      const inverterPerf = inverters.map(inv => {
        const gen = db.prepare(`
          SELECT
            SUM(pd.power_w) * 0.25 / 1000 as total_energy_kwh,
            AVG(pd.power_w) / 1000 as avg_power_kw,
            MAX(pd.power_w) / 1000 as peak_power_kw,
            COUNT(DISTINCT pd.string_id) as active_strings
          FROM power_data pd
          JOIN strings s ON pd.string_id = s.id
          WHERE s.inverter_id = ? AND pd.timestamp >= ? AND pd.timestamp < ?
        `).get(inv.id, startISO, endISO);

        const stringPerf = db.prepare(`
          SELECT s.id, s.name, s.status,
            AVG(pd.power_w) as avg_power_w,
            MAX(pd.power_w) as peak_power_w
          FROM strings s
          LEFT JOIN power_data pd ON s.id = pd.string_id AND pd.timestamp >= ? AND pd.timestamp < ?
          WHERE s.inverter_id = ?
          GROUP BY s.id
          ORDER BY avg_power_w DESC
        `).all(startISO, endISO, inv.id);

        return {
          inverter_id: inv.id,
          inverter_name: inv.name,
          model: inv.model,
          rated_power_kw: inv.rated_power_kw,
          status: inv.status,
          total_energy_kwh: Math.round((gen.total_energy_kwh || 0) * 100) / 100,
          avg_power_kw: Math.round((gen.avg_power_kw || 0) * 100) / 100,
          peak_power_kw: Math.round((gen.peak_power_kw || 0) * 100) / 100,
          active_strings: gen.active_strings || 0,
          strings: stringPerf.map(s => ({
            id: s.id,
            name: s.name,
            status: s.status,
            avg_power_w: Math.round(s.avg_power_w || 0),
            peak_power_w: Math.round(s.peak_power_w || 0),
          })),
        };
      });

      // Find best and worst performers
      const sortedByEnergy = [...inverterPerf].sort((a, b) => b.total_energy_kwh - a.total_energy_kwh);
      const best = sortedByEnergy[0];
      const worst = sortedByEnergy[sortedByEnergy.length - 1];

      generationData = [
        `- 对比期间: ${periodStr}`,
        `- 对比设备: ${inverters.length} 台逆变器, ${equip.moduleCount} 个组串`,
        `- 最佳逆变器: ${best ? `${best.inverter_name} (${best.total_energy_kwh.toFixed(1)} kWh)` : '无数据'}`,
        `- 最差逆变器: ${worst ? `${worst.inverter_name} (${worst.total_energy_kwh.toFixed(1)} kWh)` : '无数据'}`,
      ].join('\n');

      equipmentData = [
        `- 逆变器性能对比:`,
        ...inverterPerf.map(ip =>
          `    ${ip.inverter_name}: 发电${ip.total_energy_kwh.toFixed(1)}kWh, 平均${ip.avg_power_kw.toFixed(1)}kW, 峰值${ip.peak_power_kw.toFixed(1)}kW, 组串${ip.active_strings}个`
        ),
      ].join('\n');

      alertStats = '本报告中告警数据为辅助参考，详见异常分析报告';
      workorderStats = '本报告中工单数据为辅助参考，详见维护效果评估报告';
      break;
    }
  }

  const context = {
    reportType: reportTypeLabel,
    reportPeriod: periodStr,
    stationName: station.name,
    capacityMW: station.capacity_mw,
    stationLocation: station.location,
    moduleCount: equip.moduleCount,
    inverterCount: equip.inverterCount,
    generationData,
    equipmentData,
    alertStats,
    workorderStats,
    weatherData,
    sparePartsData: '无数据',
  };

  try {
    const prompt = llmService.loadPrompt('report-generation.md', context);

    const result = await llmService.structuredOutput({
      prompt,
      systemPrompt: `你是光伏电站运维报告生成专家。请根据提供的数据生成一份${reportTitle}。返回结构化JSON报告。`,
      maxTokens: 4096,
      temperature: 0.1,
      retries: 2,
    });

    return {
      success: true,
      reportType,
      period: periodStr,
      title: reportTitle,
      station: {
        id: station.id,
        name: station.name,
        capacity_mw: station.capacity_mw,
      },
      data: _getSpecialReportData(reportType, stationId, startISO, endISO, params),
      ai_report: result.data,
      ai_model: result.model,
    };
  } catch (error) {
    console.error('[Report Service] Special report LLM failed, returning data only:', error.message);
    return {
      success: true,
      reportType,
      period: periodStr,
      title: reportTitle,
      station: {
        id: station.id,
        name: station.name,
        capacity_mw: station.capacity_mw,
      },
      data: _getSpecialReportData(reportType, stationId, startISO, endISO, params),
      ai_report: null,
      ai_model: 'fallback',
      error: 'LLM generation failed, returning raw data only',
    };
  }
}

/**
 * Helper to extract structured data for special reports.
 */
function _getSpecialReportData(reportType, stationId, startISO, endISO, params) {
  switch (reportType) {
    case 'anomaly': {
      const alertsBySeverity = _queryAlertsBySeverity(stationId, startISO, endISO);
      const alertsByType = _queryAlertsByType(stationId, startISO, endISO);
      const dailyAlerts = db.prepare(`
        SELECT DATE(created_at) as date, COUNT(*) as count,
          SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical_count
        FROM alerts
        WHERE station_id = ? AND created_at >= ? AND created_at < ?
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `).all(stationId, startISO, endISO);
      const criticalAlerts = db.prepare(`
        SELECT id, severity, type, message, created_at, status
        FROM alerts
        WHERE station_id = ? AND created_at >= ? AND created_at < ?
        ORDER BY severity, created_at DESC
        LIMIT 30
      `).all(stationId, startISO, endISO);

      return {
        total_alerts: Object.values(alertsBySeverity).reduce((a, b) => a + b, 0),
        by_severity: {
          critical: alertsBySeverity.critical || 0,
          warning: alertsBySeverity.warning || 0,
          info: alertsBySeverity.info || 0,
        },
        by_type: alertsByType,
        daily_trend: dailyAlerts,
        critical_alerts: criticalAlerts.slice(0, 20),
      };
    }

    case 'maintenance': {
      const woByStatus = _queryWorkOrdersByStatus(stationId, startISO, endISO);
      const woByType = _queryWorkOrdersByType(stationId, startISO, endISO);
      const completedWOs = db.prepare(`
        SELECT id, title, type, priority, completed_at,
          julianday(completed_at) - julianday(created_at) as duration_days
        FROM work_orders
        WHERE station_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?
        ORDER BY completed_at DESC
        LIMIT 20
      `).all(stationId, startISO, endISO);
      const pendingWOs = db.prepare(`
        SELECT id, title, type, priority, created_at,
          julianday('now') - julianday(created_at) as pending_days
        FROM work_orders
        WHERE station_id = ? AND status IN ('pending', 'in_progress') AND created_at < ?
        ORDER BY created_at ASC
        LIMIT 20
      `).all(stationId, startISO, endISO);

      let avgDuration = 0;
      if (completedWOs.length > 0) {
        const totalDays = completedWOs.reduce((s, w) => s + (w.duration_days || 0), 0);
        avgDuration = Math.round((totalDays / completedWOs.length) * 10) / 10;
      }

      return {
        by_status: woByStatus,
        by_type: woByType,
        completed: completedWOs,
        pending: pendingWOs,
        avg_completion_days: avgDuration,
        total_completed: completedWOs.length,
        total_pending: pendingWOs.length,
      };
    }

    case 'comparison': {
      const inverters = db.prepare(
        'SELECT id, name, model, rated_power_kw, status FROM inverters WHERE station_id = ?'
      ).all(stationId);

      const inverterPerf = inverters.map(inv => {
        const gen = db.prepare(`
          SELECT
            SUM(pd.power_w) * 0.25 / 1000 as total_energy_kwh,
            AVG(pd.power_w) / 1000 as avg_power_kw,
            MAX(pd.power_w) / 1000 as peak_power_kw,
            COUNT(DISTINCT pd.string_id) as active_strings
          FROM power_data pd
          JOIN strings s ON pd.string_id = s.id
          WHERE s.inverter_id = ? AND pd.timestamp >= ? AND pd.timestamp < ?
        `).get(inv.id, startISO, endISO);

        return {
          inverter_id: inv.id,
          inverter_name: inv.name,
          model: inv.model,
          rated_power_kw: inv.rated_power_kw,
          status: inv.status,
          total_energy_kwh: Math.round((gen.total_energy_kwh || 0) * 100) / 100,
          avg_power_kw: Math.round((gen.avg_power_kw || 0) * 100) / 100,
          peak_power_kw: Math.round((gen.peak_power_kw || 0) * 100) / 100,
          active_strings: gen.active_strings || 0,
        };
      });

      return {
        inverters: inverterPerf,
        best_performer: inverterPerf.length > 0
          ? [...inverterPerf].sort((a, b) => b.total_energy_kwh - a.total_energy_kwh)[0]
          : null,
        worst_performer: inverterPerf.length > 0
          ? [...inverterPerf].sort((a, b) => a.total_energy_kwh - b.total_energy_kwh)[0]
          : null,
      };
    }

    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateDailyReport,
  generateWeeklyReport,
  generateMonthlyReport,
  generateSpecialReport,
};
