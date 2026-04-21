/**
 * Alert Rule Service — Configurable alert rules engine
 *
 * Manages alert rules (CRUD) and provides an evaluation engine that checks
 * current station/string data against configured thresholds.
 */
const { db } = require('../models/database');

const VALID_TYPES = [
  'string_low_power', 'string_zero_output', 'inverter_offline',
  'temperature_high', 'irradiance_low', 'power_drop_sudden',
  'string_mismatch', 'voltage_abnormal'
];
const VALID_OPERATORS = ['<', '>', '<=', '>=', '==', '!='];
const VALID_SEVERITIES = ['info', 'warning', 'critical'];

const alertRuleService = {
  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------
  getAll(filters = {}) {
    let sql = 'SELECT * FROM alert_rules WHERE 1=1';
    const params = [];

    if (filters.station_id !== undefined) {
      sql += filters.station_id === null
        ? ' AND station_id IS NULL'
        : ' AND station_id = ?';
      if (filters.station_id !== null) params.push(filters.station_id);
    }
    if (filters.type) {
      sql += ' AND type = ?';
      params.push(filters.type);
    }
    if (filters.enabled !== undefined) {
      sql += ' AND enabled = ?';
      params.push(filters.enabled ? 1 : 0);
    }

    sql += ' ORDER BY created_at DESC';
    return db.prepare(sql).all(...params);
  },

  getById(id) {
    return db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id);
  },

  create(data) {
    if (!data.name || !data.type || !data.metric || data.threshold === undefined) {
      throw new Error('name, type, metric, and threshold are required');
    }
    if (!VALID_TYPES.includes(data.type)) {
      throw new Error(`Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`);
    }
    if (!VALID_OPERATORS.includes(data.operator || '<')) {
      throw new Error(`Invalid operator. Must be one of: ${VALID_OPERATORS.join(', ')}`);
    }
    if (!VALID_SEVERITIES.includes(data.severity || 'warning')) {
      throw new Error(`Invalid severity. Must be one of: ${VALID_SEVERITIES.join(', ')}`);
    }

    const result = db.prepare(`
      INSERT INTO alert_rules
        (name, description, type, metric, operator, threshold, severity,
         station_id, enabled, cooldown_minutes, auto_create_workorder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.name,
      data.description || null,
      data.type,
      data.metric,
      data.operator || '<',
      data.threshold,
      data.severity || 'warning',
      data.station_id || null,
      data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
      data.cooldown_minutes || 30,
      data.auto_create_workorder ? 1 : 0
    );

    return this.getById(result.lastInsertRowid);
  },

  update(id, data) {
    const existing = this.getById(id);
    if (!existing) throw new Error('Alert rule not found');

    const fields = [];
    const params = [];

    const updatable = ['name', 'description', 'type', 'metric', 'operator',
      'threshold', 'severity', 'station_id', 'enabled', 'cooldown_minutes',
      'auto_create_workorder'];

    for (const key of updatable) {
      if (data[key] !== undefined) {
        if (key === 'type' && !VALID_TYPES.includes(data[key])) {
          throw new Error(`Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`);
        }
        if (key === 'operator' && !VALID_OPERATORS.includes(data[key])) {
          throw new Error(`Invalid operator. Must be one of: ${VALID_OPERATORS.join(', ')}`);
        }
        if (key === 'severity' && !VALID_SEVERITIES.includes(data[key])) {
          throw new Error(`Invalid severity. Must be one of: ${VALID_SEVERITIES.join(', ')}`);
        }
        if (key === 'enabled') {
          fields.push(`${key} = ?`);
          params.push(data[key] ? 1 : 0);
        } else if (key === 'auto_create_workorder') {
          fields.push(`${key} = ?`);
          params.push(data[key] ? 1 : 0);
        } else {
          fields.push(`${key} = ?`);
          params.push(data[key]);
        }
      }
    }

    if (fields.length === 0) return this.getById(id);

    fields.push("updated_at = datetime('now')");
    params.push(id);

    db.prepare(`UPDATE alert_rules SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return this.getById(id);
  },

  delete(id) {
    const existing = this.getById(id);
    if (!existing) throw new Error('Alert rule not found');
    db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
    return { id, deleted: true };
  },

  // -----------------------------------------------------------------------
  // Evaluation Engine
  // -----------------------------------------------------------------------

  /**
   * Evaluate all enabled rules against current station data.
   * Returns array of triggered alerts (that are not in cooldown).
   */
  evaluateAll(stationId) {
    const rules = this.getAll({ station_id: stationId, enabled: true });
    const globalRules = this.getAll({ station_id: null, enabled: true });
    const allRules = [...rules, ...globalRules];

    const triggered = [];

    for (const rule of allRules) {
      const result = this.evaluateRule(rule, stationId);
      if (result.triggered) {
        triggered.push({ rule, ...result });
      }
    }

    return triggered;
  },

  /**
   * Evaluate a single rule against current data.
   */
  evaluateRule(rule, stationId) {
    const currentValue = this.getMetricValue(rule, stationId);
    if (currentValue === null || currentValue === undefined) {
      return { triggered: false, reason: 'No data available' };
    }

    // Check cooldown — skip if a similar alert was created recently
    const cooldownCheck = db.prepare(`
      SELECT COUNT(*) as count FROM alerts
      WHERE station_id = ? AND type = ?
        AND created_at > datetime('now', ?)
    `).get(stationId, rule.type, `-${rule.cooldown_minutes} minutes`);

    if (cooldownCheck.count > 0) {
      return { triggered: false, reason: 'In cooldown period', currentValue };
    }

    // Evaluate threshold
    const triggered = this.compare(currentValue, rule.operator, rule.threshold);

    return {
      triggered,
      currentValue,
      threshold: rule.threshold,
      operator: rule.operator,
    };
  },

  /**
   * Get the current value of a metric for the given rule and station.
   */
  getMetricValue(rule, stationId) {
    switch (rule.metric) {
      case 'power_ratio': {
        // Average power ratio of strings vs rated power
        const result = db.prepare(`
          SELECT AVG(pd.power_w / s.rated_power_w) as ratio
          FROM power_data pd
          JOIN strings s ON pd.string_id = s.id
          JOIN inverters i ON s.inverter_id = i.id
          WHERE i.station_id = ?
            AND pd.timestamp = (
              SELECT MAX(timestamp) FROM power_data
              WHERE string_id = pd.string_id
            )
            AND pd.power_w > 0
        `).get(stationId);
        return result ? result.ratio : null;
      }

      case 'temperature': {
        const result = db.prepare(`
          SELECT AVG(temperature_c) as avg_temp
          FROM weather_data
          WHERE station_id = ?
            AND timestamp = (SELECT MAX(timestamp) FROM weather_data WHERE station_id = ?)
        `).get(stationId, stationId);
        return result ? result.avg_temp : null;
      }

      case 'irradiance': {
        const result = db.prepare(`
          SELECT AVG(irradiance_wm2) as avg_irr
          FROM weather_data
          WHERE station_id = ?
            AND timestamp = (SELECT MAX(timestamp) FROM weather_data WHERE station_id = ?)
        `).get(stationId, stationId);
        return result ? result.avg_irr : null;
      }

      case 'string_power': {
        // Check individual strings for low power
        const lowStrings = db.prepare(`
          SELECT s.id, s.name, pd.power_w, s.rated_power_w,
                 (pd.power_w / s.rated_power_w) as power_ratio
          FROM power_data pd
          JOIN strings s ON pd.string_id = s.id
          JOIN inverters i ON s.inverter_id = i.id
          WHERE i.station_id = ?
            AND pd.timestamp = (
              SELECT MAX(timestamp) FROM power_data
              WHERE string_id = pd.string_id
            )
            AND pd.power_w > 0
            AND (pd.power_w / s.rated_power_w) < ?
        `).all(stationId, rule.threshold);
        return lowStrings.length > 0 ? lowStrings : null;
      }

      case 'zero_output_strings': {
        // Count strings with zero output during daylight
        const irr = db.prepare(`
          SELECT AVG(irradiance_wm2) as avg_irr
          FROM weather_data WHERE station_id = ?
            AND timestamp = (SELECT MAX(timestamp) FROM weather_data WHERE station_id = ?)
        `).get(stationId, stationId);

        if (!irr || irr.avg_irr < 50) return null; // Night time, skip

        const zeroCount = db.prepare(`
          SELECT COUNT(*) as count FROM power_data pd
          JOIN strings s ON pd.string_id = s.id
          JOIN inverters i ON s.inverter_id = i.id
          WHERE i.station_id = ?
            AND pd.timestamp = (
              SELECT MAX(timestamp) FROM power_data WHERE string_id = pd.string_id
            )
            AND pd.power_w < 1
        `).get(stationId);
        return zeroCount ? zeroCount.count : null;
      }

      default:
        return null;
    }
  },

  /**
   * Compare value against threshold using the specified operator.
   */
  compare(value, operator, threshold) {
    switch (operator) {
      case '<':  return value < threshold;
      case '>':  return value > threshold;
      case '<=': return value <= threshold;
      case '>=': return value >= threshold;
      case '==': return value === threshold;
      case '!=': return value !== threshold;
      default:   return false;
    }
  },

  /**
   * Run evaluation and auto-create alerts (and optionally work orders).
   */
  runEvaluation(stationId) {
    const triggered = this.evaluateAll(stationId);
    const createdAlerts = [];

    for (const t of triggered) {
      const rule = t.rule;

      // Create alert
      const alertMsg = this.generateAlertMessage(rule, t);
      const alertResult = db.prepare(`
        INSERT INTO alerts (station_id, type, severity, message, status)
        VALUES (?, ?, ?, ?, 'active')
      `).run(stationId, rule.type, rule.severity, alertMsg);

      createdAlerts.push({ alertId: alertResult.lastInsertRowid, rule: rule.name });

      // Auto-create work order if configured
      if (rule.auto_create_workorder) {
        const workorderService = require('./workorderService');
        try {
          workorderService.create({
            title: `Auto: ${rule.name}`,
            description: alertMsg,
            type: 'defect_repair',
            priority: rule.severity === 'critical' ? 'high' : 'medium',
            station_id: stationId,
            alert_id: alertResult.lastInsertRowid,
          });
        } catch (e) {
          console.error('[AlertRuleService] Failed to auto-create work order:', e.message);
        }
      }
    }

    return { triggered: triggered.length, createdAlerts };
  },

  generateAlertMessage(rule, evaluation) {
    const currentValue = typeof evaluation.currentValue === 'number'
      ? evaluation.currentValue.toFixed(2)
      : JSON.stringify(evaluation.currentValue);

    return `规则 "${rule.name}" 触发: 当前值 ${currentValue} ${rule.operator} ${rule.threshold} (${rule.metric})`;
  },

  getStats() {
    const total = db.prepare('SELECT COUNT(*) as count FROM alert_rules').get().count;
    const enabled = db.prepare('SELECT COUNT(*) as count FROM alert_rules WHERE enabled = 1').get().count;
    const byType = db.prepare(
      'SELECT type, COUNT(*) as count FROM alert_rules GROUP BY type'
    ).all();
    const bySeverity = db.prepare(
      'SELECT severity, COUNT(*) as count FROM alert_rules GROUP BY severity'
    ).all();

    return { total, enabled, disabled: total - enabled, byType, bySeverity };
  },

  // Seed default rules for a new station
  seedDefaults(stationId) {
    const existing = this.getAll({ station_id: stationId });
    if (existing.length > 0) return existing; // already seeded

    const defaults = [
      { name: '组串功率严重偏低', type: 'string_low_power', metric: 'power_ratio', operator: '<', threshold: 0.6, severity: 'critical', auto_create_workorder: true },
      { name: '组串功率偏低', type: 'string_low_power', metric: 'power_ratio', operator: '<', threshold: 0.8, severity: 'warning', auto_create_workorder: false },
      { name: '组串零输出（白天）', type: 'string_zero_output', metric: 'zero_output_strings', operator: '>', threshold: 0, severity: 'critical', auto_create_workorder: true },
      { name: '环境温度过高', type: 'temperature_high', metric: 'temperature', operator: '>', threshold: 40, severity: 'warning', auto_create_workorder: false },
      { name: '辐照度过低', type: 'irradiance_low', metric: 'irradiance', operator: '<', threshold: 100, severity: 'info', auto_create_workorder: false },
    ];

    const results = [];
    for (const d of defaults) {
      results.push(this.create({ ...d, station_id: stationId }));
    }
    return results;
  },
};

module.exports = alertRuleService;
