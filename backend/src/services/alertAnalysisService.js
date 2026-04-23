/**
 * Alert Analysis Service — AI-powered intelligent alert analysis
 *
 * Provides alert aggregation, root cause analysis, trend analysis,
 * and actionable recommendations using LLM (via llmService).
 *
 * This is the M7 module: building on alertRuleService (rule evaluation)
 * and alertService (alert CRUD) to add intelligent analysis capabilities.
 */
const { db } = require('../models/database');
const llmService = require('./llmService');

// ---------------------------------------------------------------------------
// Internal helpers — data gathering
// ---------------------------------------------------------------------------

/**
 * Get station info by ID.
 *
 * @param {number} stationId
 * @returns {{ name: string, location: string, capacity_mw: number }|null}
 */
function _getStationInfo(stationId) {
  return db.prepare(
    'SELECT id, name, location, capacity_mw FROM stations WHERE id = ?'
  ).get(stationId);
}

/**
 * Gather all active alerts for a station with full details.
 *
 * @param {number} stationId
 * @returns {Array<object>}
 */
function _getActiveAlerts(stationId) {
  return db.prepare(`
    SELECT a.*
    FROM alerts a
    WHERE a.station_id = ? AND a.status = 'active'
    ORDER BY
      CASE a.severity
        WHEN 'critical' THEN 1
        WHEN 'warning' THEN 2
        WHEN 'info' THEN 3
      END,
      a.created_at DESC
  `).all(stationId);
}

/**
 * Get recent alert history for a station (past 24 hours).
 *
 * @param {number} stationId
 * @param {number} [hours=24]
 * @returns {Array<object>}
 */
function _getRecentAlerts(stationId, hours = 24) {
  return db.prepare(`
    SELECT * FROM alerts
    WHERE station_id = ?
      AND created_at >= datetime('now', ?)
    ORDER BY created_at DESC
    LIMIT 50
  `).all(stationId, `-${hours} hours`);
}

/**
 * Get inverters and their strings for a station, with latest power data.
 *
 * @param {number} stationId
 * @returns {Array<object>}
 */
function _getInverterContext(stationId) {
  return db.prepare(`
    SELECT i.id, i.name, i.model, i.status,
      (SELECT COUNT(*) FROM strings WHERE inverter_id = i.id) as string_count
    FROM inverters i
    WHERE i.station_id = ?
    ORDER BY i.id
  `).all(stationId);
}

/**
 * Get abnormal strings (low power ratio) for a station.
 *
 * @param {number} stationId
 * @returns {Array<object>}
 */
function _getAbnormalStrings(stationId) {
  return db.prepare(`
    SELECT s.id, s.name, s.rated_power_w, s.status,
           pd.power_w, pd.voltage_v, pd.current_a,
           pd.power_w / s.rated_power_w as power_ratio
    FROM power_data pd
    JOIN strings s ON pd.string_id = s.id
    JOIN inverters i ON s.inverter_id = i.id
    WHERE i.station_id = ?
      AND pd.timestamp = (
        SELECT MAX(pd2.timestamp) FROM power_data pd2
        WHERE pd2.string_id = pd.string_id
      )
      AND (pd.power_w / s.rated_power_w) < 0.8
      AND pd.power_w > 0
    ORDER BY power_ratio ASC
    LIMIT 20
  `).all(stationId);
}

/**
 * Get latest weather data for a station.
 *
 * @param {number} stationId
 * @returns {object|null}
 */
function _getLatestWeather(stationId) {
  return db.prepare(`
    SELECT * FROM weather_data
    WHERE station_id = ?
      AND timestamp = (SELECT MAX(timestamp) FROM weather_data WHERE station_id = ?)
  `).get(stationId, stationId);
}

/**
 * Get latest power summary for a station (total/average metrics).
 *
 * @param {number} stationId
 * @returns {object|null}
 */
function _getPowerSummary(stationId) {
  return db.prepare(`
    SELECT
      COUNT(DISTINCT pd.string_id) as active_strings,
      SUM(pd.power_w) as total_power_w,
      AVG(pd.power_w) as avg_power_w,
      AVG(pd.voltage_v) as avg_voltage_v,
      AVG(pd.current_a) as avg_current_a
    FROM power_data pd
    JOIN strings s ON pd.string_id = s.id
    JOIN inverters i ON s.inverter_id = i.id
    WHERE i.station_id = ?
      AND pd.timestamp = (
        SELECT MAX(pd2.timestamp) FROM power_data pd2
        WHERE pd2.string_id = pd.string_id
      )
  `).get(stationId);
}

/**
 * Format alerts into a human-readable text block for the LLM prompt.
 *
 * @param {Array<object>} alerts
 * @returns {string}
 */
function _formatAlerts(alerts) {
  if (!alerts || alerts.length === 0) return '无';
  return alerts.map((a, i) =>
    `${i + 1}. [${a.severity}] ${a.type} — ${a.message} (创建时间: ${a.created_at})`
  ).join('\n');
}

/**
 * Format inverter context for the LLM prompt.
 *
 * @param {Array<object>} inverters
 * @param {Array<object>} abnormalStrings
 * @param {object} powerSummary
 * @returns {string}
 */
function _formatDeviceInfo(inverters, abnormalStrings, powerSummary) {
  const lines = [];

  if (inverters && inverters.length > 0) {
    lines.push('逆变器状态:');
    inverters.forEach((inv) => {
      lines.push(`  - ${inv.name} (${inv.model}): ${inv.status}, ${inv.string_count}个组串`);
    });
  }

  if (powerSummary) {
    lines.push(
      `功率汇总: 总功率 ${(powerSummary.total_power_w / 1000).toFixed(2)} kW, ` +
      `平均组串功率 ${powerSummary.avg_power_w.toFixed(1)} W, ` +
      `平均电压 ${powerSummary.avg_voltage_v.toFixed(1)} V, ` +
      `平均电流 ${powerSummary.avg_current_a.toFixed(2)} A`
    );
  }

  if (abnormalStrings && abnormalStrings.length > 0) {
    lines.push('异常组串 (功率比 < 80%):');
    abnormalStrings.forEach((s) => {
      lines.push(
        `  - ${s.name}: 功率 ${s.power_w.toFixed(1)} W / 额定 ${s.rated_power_w.toFixed(1)} W, ` +
        `功率比 ${(s.power_ratio * 100).toFixed(1)}%, ` +
        `电压 ${s.voltage_v.toFixed(1)} V, 电流 ${s.current_a.toFixed(2)} A`
      );
    });
  }

  return lines.join('\n') || '暂无设备数据';
}

/**
 * Format weather data for the LLM prompt.
 *
 * @param {object|null} weather
 * @returns {string}
 */
function _formatWeather(weather) {
  if (!weather) return '暂无气象数据';
  return (
    `辐照度 ${weather.irradiance_wm2.toFixed(1)} W/m², ` +
    `温度 ${weather.temperature_c.toFixed(1)} °C, ` +
    `风速 ${weather.wind_speed_ms.toFixed(1)} m/s`
  );
}

// ---------------------------------------------------------------------------
// LLM schemas for structured output
// ---------------------------------------------------------------------------

/** Schema for alert aggregation & analysis */
const ALERT_ANALYSIS_SCHEMA = {
  type: 'object',
  required: [
    'event_groups', 'root_causes', 'severity_reassessment',
    'recommended_actions', 'summary',
  ],
  properties: {
    event_groups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['group_name', 'alert_ids', 'description'],
        properties: {
          group_name: { type: 'string' },
          alert_ids: { type: 'array', items: { type: 'number' } },
          description: { type: 'string' },
        },
      },
    },
    root_causes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['cause', 'confidence', 'evidence', 'affected_alert_ids'],
        properties: {
          cause: { type: 'string' },
          confidence: { type: 'number' },
          evidence: { type: 'string' },
          affected_alert_ids: { type: 'array', items: { type: 'number' } },
        },
      },
    },
    severity_reassessment: {
      type: 'array',
      items: {
        type: 'object',
        required: ['alert_id', 'original_severity', 'reassessed_severity', 'reason'],
        properties: {
          alert_id: { type: 'number' },
          original_severity: { type: 'string' },
          reassessed_severity: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    recommended_actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['step', 'action', 'priority'],
        properties: {
          step: { type: 'number' },
          action: { type: 'string' },
          priority: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
};

/** Schema for single alert root cause analysis */
const ROOT_CAUSE_SCHEMA = {
  type: 'object',
  required: ['root_cause', 'confidence', 'evidence', 'recommended_actions'],
  properties: {
    root_cause: { type: 'string' },
    confidence: { type: 'number' },
    evidence: { type: 'string' },
    recommended_actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['step', 'action', 'priority'],
        properties: {
          step: { type: 'number' },
          action: { type: 'string' },
          priority: { type: 'string' },
        },
      },
    },
    estimated_resolution_time: { type: 'string' },
    need_dispatch: { type: 'boolean' },
  },
};

/** Schema for trend analysis */
const TREND_ANALYSIS_SCHEMA = {
  type: 'object',
  required: ['patterns', 'predictions', 'preventive_measures', 'summary'],
  properties: {
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        required: ['pattern_type', 'description', 'frequency'],
        properties: {
          pattern_type: { type: 'string' },
          description: { type: 'string' },
          frequency: { type: 'string' },
        },
      },
    },
    predictions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['alert_type', 'likelihood', 'timeframe', 'reason'],
        properties: {
          alert_type: { type: 'string' },
          likelihood: { type: 'string' },
          timeframe: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    preventive_measures: {
      type: 'array',
      items: {
        type: 'object',
        required: ['measure', 'impact', 'effort'],
        properties: {
          measure: { type: 'string' },
          impact: { type: 'string' },
          effort: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const alertAnalysisService = {
  /**
   * Perform intelligent analysis on all active alerts for a station.
   *
   * Queries active alerts, gathers device context and weather data,
   * then uses LLM to perform:
   *   - Alert aggregation (group related alerts into events)
   *   - Root cause analysis
   *   - Severity reassessment
   *   - Actionable recommendations
   *
   * @param {number} stationId - Station ID to analyze
   * @returns {Promise<{
   *   station: object,
   *   alert_count: number,
   *   event_groups: Array,
   *   root_causes: Array,
   *   severity_reassessment: Array,
   *   recommended_actions: Array,
   *   summary: string,
   *   model: string,
   *   llm_valid: boolean,
   *   fallback: boolean
   * }>}
   */
  async analyzeActiveAlerts(stationId) {
    const station = _getStationInfo(stationId);
    if (!station) {
      throw new Error(`Station not found: ${stationId}`);
    }

    const activeAlerts = _getActiveAlerts(stationId);
    if (activeAlerts.length === 0) {
      return {
        station: { id: station.id, name: station.name },
        alert_count: 0,
        event_groups: [],
        root_causes: [],
        severity_reassessment: [],
        recommended_actions: [],
        summary: '当前无活跃告警',
        model: 'none',
        llm_valid: true,
        fallback: false,
      };
    }

    // Gather context
    const inverters = _getInverterContext(stationId);
    const abnormalStrings = _getAbnormalStrings(stationId);
    const powerSummary = _getPowerSummary(stationId);
    const weather = _getLatestWeather(stationId);
    const recentAlerts = _getRecentAlerts(stationId, 24);

    // Build context object for the prompt
    const context = {
      stationName: station.name,
      alertTime: new Date().toISOString(),
      alertLevel: activeAlerts.map((a) => a.severity).join(', '),
      alertType: [...new Set(activeAlerts.map((a) => a.type))].join(', '),
      alertMessage: activeAlerts.map((a) => a.message).join('; '),
      deviceInfo: _formatDeviceInfo(inverters, abnormalStrings, powerSummary),
      historyAlerts: _formatAlerts(recentAlerts),
      currentParams: _formatWeather(weather),
    };

    // Load prompt and call LLM
    let prompt;
    try {
      prompt = llmService.loadPrompt('alert-analysis.md', context);
    } catch (err) {
      console.error('[AlertAnalysisService] Failed to load prompt, using fallback:', err.message);
      return _buildFallbackAnalysis(station, activeAlerts, inverters, abnormalStrings, weather);
    }

    try {
      const result = await llmService.structuredOutput({
        prompt,
        systemPrompt: '你是光伏电站运维告警分析专家。请严格按照要求的 JSON 格式返回分析结果。',
        schema: ALERT_ANALYSIS_SCHEMA,
        maxTokens: 4096,
        temperature: 0.1,
      });

      return {
        station: { id: station.id, name: station.name },
        alert_count: activeAlerts.length,
        alerts: activeAlerts,
        event_groups: result.data?.event_groups || [],
        root_causes: result.data?.root_causes || [],
        severity_reassessment: result.data?.severity_reassessment || [],
        recommended_actions: result.data?.recommended_actions || [],
        summary: result.data?.summary || '分析完成',
        model: result.model,
        llm_valid: result.valid,
        fallback: !result.valid,
        raw: result.raw,
      };
    } catch (error) {
      console.error('[AlertAnalysisService] LLM analysis failed, using fallback:', error.message);
      return _buildFallbackAnalysis(station, activeAlerts, inverters, abnormalStrings, weather);
    }
  },

  /**
   * Perform root cause analysis for a single alert.
   *
   * Queries alert details, associated device status (inverter/string power data),
   * recent alert history, and weather conditions, then uses LLM to analyze
   * the root cause.
   *
   * @param {number} alertId - Alert ID to analyze
   * @returns {Promise<{
   *   alert: object,
   *   root_cause: string,
   *   confidence: number,
   *   evidence: string,
   *   recommended_actions: Array,
   *   estimated_resolution_time: string,
   *   need_dispatch: boolean,
   *   device_context: object,
   *   model: string
   * }>}
   */
  async getAlertRootCause(alertId) {
    // Get alert details
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);
    if (!alert) {
      throw new Error(`Alert not found: ${alertId}`);
    }

    const station = _getStationInfo(alert.station_id);
    const inverters = _getInverterContext(alert.station_id);
    const abnormalStrings = _getAbnormalStrings(alert.station_id);
    const powerSummary = _getPowerSummary(alert.station_id);
    const weather = _getLatestWeather(alert.station_id);
    const recentAlerts = _getRecentAlerts(alert.station_id, 24);

    // Get related alerts of the same type
    const relatedAlerts = db.prepare(`
      SELECT * FROM alerts
      WHERE station_id = ? AND type = ? AND id != ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(alert.station_id, alert.type, alertId);

    const context = {
      stationName: station?.name || 'Unknown',
      alertTime: alert.created_at,
      alertLevel: alert.severity,
      alertType: alert.type,
      alertMessage: alert.message,
      deviceInfo: _formatDeviceInfo(inverters, abnormalStrings, powerSummary),
      historyAlerts: _formatAlerts([...relatedAlerts, ...recentAlerts.slice(0, 10)]),
      currentParams: _formatWeather(weather),
    };

    let prompt;
    try {
      prompt = llmService.loadPrompt('alert-analysis.md', context);
    } catch (err) {
      console.error('[AlertAnalysisService] Failed to load prompt for root cause:', err.message);
      return _buildFallbackRootCause(alert, station);
    }

    try {
      const result = await llmService.structuredOutput({
        prompt,
        systemPrompt: '你是光伏电站运维告警根因分析专家。请分析以下告警的根本原因，并给出具体处置建议。',
        schema: ROOT_CAUSE_SCHEMA,
        maxTokens: 2048,
        temperature: 0.1,
      });

      return {
        alert,
        root_cause: result.data?.root_cause || '无法确定根因',
        confidence: result.data?.confidence || 0.5,
        evidence: result.data?.evidence || '',
        recommended_actions: result.data?.recommended_actions || [],
        estimated_resolution_time: result.data?.estimated_resolution_time || '未知',
        need_dispatch: result.data?.need_dispatch || false,
        device_context: {
          inverters,
          abnormal_strings: abnormalStrings,
          power_summary: powerSummary,
          weather,
        },
        model: result.model,
      };
    } catch (error) {
      console.error('[AlertAnalysisService] Root cause analysis failed:', error.message);
      return _buildFallbackRootCause(alert, station);
    }
  },

  /**
   * Analyze alert trends for a station over a time window.
   *
   * Queries historical alerts, computes statistics by type/severity/time period,
   * then uses LLM to identify patterns, predict future alerts, and suggest
   * preventive measures.
   *
   * @param {number} stationId - Station ID to analyze
   * @param {number} [days=7] - Number of days to look back
   * @returns {Promise<{
   *   station: object,
   *   time_range: { start: string, end: string, days: number },
   *   statistics: { total: number, by_type: Array, by_severity: Array, by_hour: Array },
   *   patterns: Array,
   *   predictions: Array,
   *   preventive_measures: Array,
   *   summary: string,
   *   model: string
   * }>}
   */
  async analyzeAlertTrend(stationId, days = 7) {
    const station = _getStationInfo(stationId);
    if (!station) {
      throw new Error(`Station not found: ${stationId}`);
    }

    const startTime = `-${days} days`;
    const endTime = 'now';

    // Total alerts in period
    const totalResult = db.prepare(`
      SELECT COUNT(*) as count FROM alerts
      WHERE station_id = ? AND created_at >= datetime(?) AND created_at <= datetime(?)
    `).get(stationId, startTime, endTime);
    const totalAlerts = totalResult?.count || 0;

    // By type
    const byType = db.prepare(`
      SELECT type, COUNT(*) as count,
        SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical_count,
        SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) as warning_count,
        SUM(CASE WHEN severity = 'info' THEN 1 ELSE 0 END) as info_count
      FROM alerts
      WHERE station_id = ? AND created_at >= datetime(?) AND created_at <= datetime(?)
      GROUP BY type
      ORDER BY count DESC
    `).all(stationId, startTime, endTime);

    // By severity
    const bySeverity = db.prepare(`
      SELECT severity, COUNT(*) as count
      FROM alerts
      WHERE station_id = ? AND created_at >= datetime(?) AND created_at <= datetime(?)
      GROUP BY severity
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 1
          WHEN 'warning' THEN 2
          WHEN 'info' THEN 3
        END
    `).all(stationId, startTime, endTime);

    // By hour of day (to detect time-based patterns)
    const byHour = db.prepare(`
      SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour,
             COUNT(*) as count
      FROM alerts
      WHERE station_id = ? AND created_at >= datetime(?) AND created_at <= datetime(?)
      GROUP BY hour
      ORDER BY hour
    `).all(stationId, startTime, endTime);

    // Get the actual alert messages for context
    const historicalAlerts = db.prepare(`
      SELECT * FROM alerts
      WHERE station_id = ? AND created_at >= datetime(?) AND created_at <= datetime(?)
      ORDER BY created_at DESC
      LIMIT 100
    `).all(stationId, startTime, endTime);

    // Build trend context
    const trendContext = {
      stationName: station.name,
      days: String(days),
      totalAlerts: String(totalAlerts),
      byType: byType.map((t) => `${t.type}: ${t.count}次 (critical:${t.critical_count}, warning:${t.warning_count}, info:${t.info_count})`).join('\n') || '无数据',
      bySeverity: bySeverity.map((s) => `${s.severity}: ${s.count}次`).join('\n') || '无数据',
      byHour: byHour.map((h) => `${String(h.hour).padStart(2, '0')}:00 — ${h.count}次`).join('\n') || '无数据',
      alertsList: _formatAlerts(historicalAlerts),
    };

    // Build a specialized prompt for trend analysis
    const trendPrompt = llmService.loadPrompt('alert-analysis.md', {
      stationName: trendContext.stationName,
      alertTime: new Date().toISOString(),
      alertLevel: bySeverity.map((s) => s.severity).join(', '),
      alertType: byType.map((t) => t.type).join(', '),
      alertMessage: `过去${days}天共${totalAlerts}条告警。类型分布:\n${trendContext.byType}\n\n严重度分布:\n${trendContext.bySeverity}\n\n时段分布:\n${trendContext.byHour}`,
      deviceInfo: `分析时间范围: ${days}天`,
      historyAlerts: trendContext.alertsList,
      currentParams: `总告警数: ${totalAlerts}`,
    });

    try {
      const result = await llmService.structuredOutput({
        prompt: trendPrompt,
        systemPrompt: `你是光伏电站运维告警趋势分析专家。请分析该电站过去${days}天的告警趋势，识别模式规律，预测未来风险，并给出预防措施。请严格按照 JSON 格式返回。`,
        schema: TREND_ANALYSIS_SCHEMA,
        maxTokens: 4096,
        temperature: 0.1,
      });

      return {
        station: { id: station.id, name: station.name },
        time_range: {
          start: new Date(Date.now() - days * 86400000).toISOString(),
          end: new Date().toISOString(),
          days,
        },
        statistics: {
          total: totalAlerts,
          by_type: byType,
          by_severity: bySeverity,
          by_hour: byHour,
        },
        patterns: result.data?.patterns || [],
        predictions: result.data?.predictions || [],
        preventive_measures: result.data?.preventive_measures || [],
        summary: result.data?.summary || '趋势分析完成',
        model: result.model,
      };
    } catch (error) {
      console.error('[AlertAnalysisService] Trend analysis failed:', error.message);
      return _buildFallbackTrend(station, totalAlerts, byType, bySeverity, byHour, days);
    }
  },

  /**
   * Batch analyze multiple alerts in parallel.
   *
   * @param {number[]} alertIds - Array of alert IDs to analyze
   * @returns {Promise<{
   *   total: number,
   *   successful: number,
   *   failed: number,
   *   results: Array<{alert_id: number, root_cause: string, confidence: number, error?: string}>,
   *   aggregate_summary: string
   * }>}
   */
  async batchAnalyzeAlerts(alertIds) {
    if (!alertIds || alertIds.length === 0) {
      return {
        total: 0,
        successful: 0,
        failed: 0,
        results: [],
        aggregate_summary: '未提供告警ID',
      };
    }

    const results = await Promise.allSettled(
      alertIds.map(async (id) => {
        const analysis = await this.getAlertRootCause(id);
        return {
          alert_id: id,
          root_cause: analysis.root_cause,
          confidence: analysis.confidence,
          recommended_actions: analysis.recommended_actions,
          need_dispatch: analysis.need_dispatch,
        };
      })
    );

    const successful = [];
    const failed = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successful.push(result.value);
      } else {
        failed.push({ alert_id: alertIds[index], error: result.reason?.message || 'Unknown error' });
      }
    });

    // Build aggregate summary
    const dispatchNeeded = successful.filter((r) => r.need_dispatch).length;
    const highConfidence = successful.filter((r) => r.confidence >= 0.7).length;

    const aggregateSummary = `共分析 ${alertIds.length} 条告警，成功 ${successful.length} 条，失败 ${failed.length} 条。` +
      `其中 ${dispatchNeeded} 条建议派遣人员处理，${highConfidence} 条分析置信度 >= 70%。`;

    return {
      total: alertIds.length,
      successful: successful.length,
      failed: failed.length,
      results: [...successful, ...failed],
      aggregate_summary: aggregateSummary,
    };
  },
};

// ---------------------------------------------------------------------------
// Fallback functions (when LLM is unavailable)
// ---------------------------------------------------------------------------

/**
 * Build a fallback analysis result without LLM.
 * Uses rule-based heuristics to provide basic analysis.
 */
function _buildFallbackAnalysis(station, activeAlerts, inverters, abnormalStrings, weather) {
  const criticalAlerts = activeAlerts.filter((a) => a.severity === 'critical');
  const warningAlerts = activeAlerts.filter((a) => a.severity === 'warning');
  const infoAlerts = activeAlerts.filter((a) => a.severity === 'info');

  // Group by type (simple rule-based aggregation)
  const typeGroups = {};
  activeAlerts.forEach((a) => {
    if (!typeGroups[a.type]) typeGroups[a.type] = { group_name: a.type, alert_ids: [], description: '' };
    typeGroups[a.type].alert_ids.push(a.id);
  });
  const eventGroups = Object.values(typeGroups).map((g) => ({
    ...g,
    description: `${g.group_name} 类型告警，共 ${g.alert_ids.length} 条`,
  }));

  // Basic root cause inference
  const rootCauses = [];
  if (criticalAlerts.length > 0) {
    rootCauses.push({
      cause: '存在 critical 级别告警，需要立即关注',
      confidence: 0.8,
      evidence: `${criticalAlerts.length} 条 critical 告警: ${criticalAlerts.map((a) => a.type).join(', ')}`,
      affected_alert_ids: criticalAlerts.map((a) => a.id),
    });
  }
  if (abnormalStrings && abnormalStrings.length > 3) {
    rootCauses.push({
      cause: '多个组串功率异常偏低，可能存在共性问题（如逆变器故障、遮挡、接线问题）',
      confidence: 0.6,
      evidence: `${abnormalStrings.length} 个组串功率比低于 80%`,
      affected_alert_ids: activeAlerts.map((a) => a.id),
    });
  }

  // Severity reassessment
  const severityReassessment = activeAlerts.map((a) => ({
    alert_id: a.id,
    original_severity: a.severity,
    reassessed_severity: a.severity,
    reason: '基于规则保持原级别（LLM 不可用）',
  }));

  // Basic recommendations
  const recommendedActions = [];
  if (criticalAlerts.length > 0) {
    recommendedActions.push({ step: 1, action: '立即检查 critical 告警对应的设备状态', priority: 'immediate' });
    recommendedActions.push({ step: 2, action: '派遣运维人员到现场确认', priority: 'immediate' });
  }
  if (warningAlerts.length > 0) {
    recommendedActions.push({ step: recommendedActions.length + 1, action: '安排巡检 warning 告警涉及的设备', priority: 'scheduled' });
  }
  if (infoAlerts.length > 0) {
    recommendedActions.push({ step: recommendedActions.length + 1, action: '持续关注 info 级别告警变化趋势', priority: 'monitor' });
  }

  return {
    station: { id: station.id, name: station.name },
    alert_count: activeAlerts.length,
    alerts: activeAlerts,
    event_groups: eventGroups,
    root_causes: rootCauses,
    severity_reassessment: severityReassessment,
    recommended_actions: recommendedActions,
    summary: `当前有 ${activeAlerts.length} 条活跃告警（critical: ${criticalAlerts.length}, warning: ${warningAlerts.length}, info: ${infoAlerts.length}）。LLM 分析不可用，已使用规则引擎提供基础分析。`,
    model: 'rule-based-fallback',
    llm_valid: false,
    fallback: true,
  };
}

/**
 * Build a fallback root cause analysis without LLM.
 */
function _buildFallbackRootCause(alert, station) {
  const needDispatch = alert.severity === 'critical';

  let rootCause = '无法自动确定根因';
  let confidence = 0.3;
  let evidence = 'LLM 分析不可用';
  const recommendedActions = [];

  // Rule-based inference
  if (alert.type.includes('zero_output') || alert.type.includes('string_zero')) {
    rootCause = '组串零输出，可能原因：组串断路、保险丝熔断、接线松动或遮挡';
    confidence = 0.6;
    evidence = `告警类型 ${alert.type} 通常表示组串完全无输出`;
    recommendedActions.push(
      { step: 1, action: '检查组串接线和保险丝', priority: 'immediate' },
      { step: 2, action: '检查组串是否有遮挡或损坏', priority: 'scheduled' }
    );
  } else if (alert.type.includes('low_power') || alert.type.includes('string_low')) {
    rootCause = '组串功率偏低，可能原因：组件老化、局部遮挡、接线电阻过大或逆变器MPPT异常';
    confidence = 0.5;
    evidence = `告警类型 ${alert.type} 表示功率低于阈值`;
    recommendedActions.push(
      { step: 1, action: '对比同组其他组串的功率数据', priority: 'scheduled' },
      { step: 2, action: '检查组串组件是否有遮挡或损坏', priority: 'scheduled' }
    );
  } else if (alert.type.includes('inverter') || alert.type.includes('offline')) {
    rootCause = '逆变器离线或异常，可能原因：通信中断、设备故障或保护动作';
    confidence = 0.5;
    evidence = `告警类型 ${alert.type} 表示逆变器状态异常`;
    recommendedActions.push(
      { step: 1, action: '检查逆变器通信状态', priority: 'immediate' },
      { step: 2, action: '查看逆变器面板故障代码', priority: 'immediate' }
    );
  } else if (alert.type.includes('temperature') || alert.type.includes('temp')) {
    rootCause = '温度异常，可能原因：环境温度过高、散热不良或温度传感器故障';
    confidence = 0.4;
    evidence = `告警类型 ${alert.type} 表示温度超出正常范围`;
    recommendedActions.push(
      { step: 1, action: '检查环境温度和设备散热情况', priority: 'scheduled' },
      { step: 2, action: '校验温度传感器读数', priority: 'monitor' }
    );
  } else {
    recommendedActions.push(
      { step: 1, action: '查看告警详情和相关设备数据', priority: 'scheduled' },
      { step: 2, action: '联系运维人员现场确认', priority: needDispatch ? 'immediate' : 'scheduled' }
    );
  }

  if (needDispatch && recommendedActions.length > 0) {
    recommendedActions.unshift(
      { step: 0, action: '派遣运维人员到现场处理', priority: 'immediate' }
    );
  }

  return {
    alert,
    root_cause: rootCause,
    confidence,
    evidence,
    recommended_actions: recommendedActions,
    estimated_resolution_time: needDispatch ? '2-4小时' : '待现场确认',
    need_dispatch: needDispatch,
    device_context: {},
    model: 'rule-based-fallback',
  };
}

/**
 * Build a fallback trend analysis without LLM.
 */
function _buildFallbackTrend(station, totalAlerts, byType, bySeverity, byHour, days) {
  // Find peak hours
  let peakHour = 'N/A';
  let peakCount = 0;
  if (byHour && byHour.length > 0) {
    const peak = byHour.reduce((max, h) => (h.count > max.count ? h : max), byHour[0]);
    peakHour = `${String(peak.hour).padStart(2, '0')}:00`;
    peakCount = peak.count;
  }

  // Find most common alert type
  const topType = byType && byType.length > 0 ? byType[0] : null;

  // Find dominant severity
  const topSeverity = bySeverity && bySeverity.length > 0 ? bySeverity[0] : null;

  const patterns = [];
  if (topType) {
    patterns.push({
      pattern_type: 'dominant_type',
      description: `最常见的告警类型是 ${topType.type}，共 ${topType.count} 次`,
      frequency: `${topType.count} 次 / ${days} 天`,
    });
  }
  if (topSeverity) {
    patterns.push({
      pattern_type: 'dominant_severity',
      description: `最常见的告警级别是 ${topSeverity.severity}，共 ${topSeverity.count} 次`,
      frequency: `${topSeverity.count} 次 / ${days} 天`,
    });
  }
  if (peakHour !== 'N/A') {
    patterns.push({
      pattern_type: 'time_pattern',
      description: `告警高发时段为 ${peakHour}，该时段出现 ${peakCount} 次告警`,
      frequency: `${peakCount} 次`,
    });
  }

  const predictions = [];
  if (topType) {
    predictions.push({
      alert_type: topType.type,
      likelihood: totalAlerts > 10 ? 'high' : 'medium',
      timeframe: '未来7天',
      reason: `基于历史数据，该类型告警在过去 ${days} 天出现 ${topType.count} 次`,
    });
  }

  const preventiveMeasures = [];
  if (topType && topType.type.includes('string')) {
    preventiveMeasures.push({
      measure: '加强组串巡检频率',
      impact: '减少组串相关告警',
      effort: 'medium',
    });
  }
  preventiveMeasures.push({
    measure: '定期检查设备通信状态',
    impact: '降低通信中断类告警',
    effort: 'low',
  });
  preventiveMeasures.push({
    measure: '优化告警规则阈值以减少误报',
    impact: '降低无效告警数量',
    effort: 'low',
  });

  return {
    station: { id: station.id, name: station.name },
    time_range: {
      start: new Date(Date.now() - days * 86400000).toISOString(),
      end: new Date().toISOString(),
      days,
    },
    statistics: {
      total: totalAlerts,
      by_type: byType,
      by_severity: bySeverity,
      by_hour: byHour,
    },
    patterns,
    predictions,
    preventive_measures: preventiveMeasures,
    summary: `过去 ${days} 天共 ${totalAlerts} 条告警。LLM 分析不可用，已基于统计数据提供基础趋势分析。` +
      (topType ? ` 最常见告警类型: ${topType.type} (${topType.count} 次)。` : '') +
      (peakHour !== 'N/A' ? ` 高发时段: ${peakHour} (${peakCount} 次)。` : ''),
    model: 'rule-based-fallback',
  };
}

module.exports = alertAnalysisService;
