/**
 * Alert Evaluation Scheduler — Automated rule evaluation engine
 *
 * Evaluates all enabled alert rules against current station data
 * on a fixed interval (every 5 minutes). Auto-creates alerts and
 * optionally work orders when rules are triggered.
 *
 * Uses setInterval (not cron) and exposes evaluation status.
 */
const { db } = require('../models/database');
const alertService = require('./alertService');
const workorderService = require('./workorderService');
const stationService = require('./stationService');
const wsService = require('./websocketService');

// Lazy prepared statement for recording evaluation history
// (must be created after initDatabase() runs, which creates the table)
let _insertEvaluationStmt = null;
function getInsertEvaluationStmt() {
  if (!_insertEvaluationStmt) {
    _insertEvaluationStmt = db.prepare(`
      INSERT INTO alert_rule_evaluations (rule_id, station_id, triggered, current_value, threshold_value, alert_created)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }
  return _insertEvaluationStmt;
}

// ---------------------------------------------------------------------------
// Evaluation status tracker
// ---------------------------------------------------------------------------
const evaluationStatus = {
  lastRunAt: null,
  lastRunDurationMs: null,
  lastRunResults: null,
  totalEvaluations: 0,
  totalAlertsCreated: 0,
  totalWorkOrdersCreated: 0,
  isRunning: false,
  error: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compare(value, operator, threshold) {
  switch (operator) {
    case '<':  return value < threshold;
    case '>':  return value > threshold;
    case '<=': return value <= threshold;
    case '>=': return value >= threshold;
    case '==': return value === threshold;
    case '!=': return value !== threshold;
    default:   return false;
  }
}

/**
 * Check if a rule is in its cooldown period for the given station.
 * Returns true if in cooldown (should skip).
 */
function isInCooldown(rule, stationId) {
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM alerts
    WHERE station_id = ? AND type = ?
      AND created_at > datetime('now', '-' || ? || ' minutes')
  `).get(stationId, rule.type, rule.cooldown_minutes);
  return result.count > 0;
}

/**
 * Get latest power data for a string.
 * If timeOffset is provided (e.g., '-15 minutes'), get the latest reading
 * at or before that offset from now.
 */
function getLatestPowerDataForString(stringId, timeOffset) {
  if (timeOffset) {
    // Get latest reading at or before the time offset
    const result = db.prepare(`
      SELECT pd.*, s.rated_power_w
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      WHERE pd.string_id = ?
        AND pd.timestamp <= datetime('now', ?)
      ORDER BY pd.timestamp DESC
      LIMIT 1
    `).get(stringId, timeOffset);
    return result;
  } else {
    // Get the absolute latest reading
    const result = db.prepare(`
      SELECT pd.*, s.rated_power_w
      FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      WHERE pd.string_id = ?
        AND pd.timestamp = (
          SELECT MAX(timestamp) FROM power_data WHERE string_id = ?
        )
    `).get(stringId, stringId);
    return result;
  }
}

/**
 * Get latest weather data for a station.
 */
function getLatestWeather(stationId) {
  return db.prepare(`
    SELECT * FROM weather_data
    WHERE station_id = ?
    ORDER BY timestamp DESC LIMIT 1
  `).get(stationId);
}

/**
 * Get all inverters for a station.
 */
function getInvertersForStation(stationId) {
  return db.prepare('SELECT * FROM inverters WHERE station_id = ?').all(stationId);
}

/**
 * Get all strings for an inverter.
 */
function getStringsForInverter(inverterId) {
  return db.prepare(`
    SELECT s.* FROM strings s WHERE s.inverter_id = ?
  `).all(inverterId);
}

// ---------------------------------------------------------------------------
// Rule type evaluators
// Each returns an array of { triggered, details } or []
// ---------------------------------------------------------------------------

/**
 * string_low_power: Compare each string's latest power_ratio against threshold.
 */
function evaluateStringLowPower(rule, stationId) {
  const strings = db.prepare(`
    SELECT s.id, s.name, s.rated_power_w, i.id as inverter_id
    FROM strings s
    JOIN inverters i ON s.inverter_id = i.id
    WHERE i.station_id = ?
  `).all(stationId);

  const triggered = [];
  for (const s of strings) {
    const pd = getLatestPowerDataForString(s.id);
    if (!pd || pd.power_w <= 0) continue;

    const powerRatio = pd.power_w / s.rated_power_w;
    if (compare(powerRatio, rule.operator, rule.threshold)) {
      triggered.push({
        triggered: true,
        details: `${s.name} power_ratio=${powerRatio.toFixed(3)} ${rule.operator} ${rule.threshold}`,
        stringId: s.id,
        stringName: s.name,
        currentValue: powerRatio,
      });
    }
  }
  return triggered;
}

/**
 * string_zero_output: Check if any string has 0 power during daytime (irradiance > 100).
 */
function evaluateStringZeroOutput(rule, stationId) {
  const weather = getLatestWeather(stationId);
  if (!weather || weather.irradiance_wm2 <= 100) {
    return []; // Nighttime or low irradiance — skip
  }

  const strings = db.prepare(`
    SELECT s.id, s.name
    FROM strings s
    JOIN inverters i ON s.inverter_id = i.id
    WHERE i.station_id = ?
  `).all(stationId);

  const zeroStrings = [];
  for (const s of strings) {
    const pd = getLatestPowerDataForString(s.id);
    if (pd && pd.power_w < 1) {
      zeroStrings.push(s.name);
    }
  }

  if (zeroStrings.length > 0) {
    return [{
      triggered: true,
      details: `${zeroStrings.length} string(s) with zero output during daylight: ${zeroStrings.join(', ')}`,
      currentValue: zeroStrings.length,
    }];
  }
  return [];
}

/**
 * temperature_high: Compare latest weather temperature against threshold.
 */
function evaluateTemperatureHigh(rule, stationId) {
  const weather = getLatestWeather(stationId);
  if (!weather) return [];

  if (compare(weather.temperature_c, rule.operator, rule.threshold)) {
    return [{
      triggered: true,
      details: `Temperature ${weather.temperature_c}°C ${rule.operator} ${rule.threshold}°C`,
      currentValue: weather.temperature_c,
    }];
  }
  return [];
}

/**
 * irradiance_low: Compare latest weather irradiance against threshold.
 */
function evaluateIrradianceLow(rule, stationId) {
  const weather = getLatestWeather(stationId);
  if (!weather) return [];

  if (compare(weather.irradiance_wm2, rule.operator, rule.threshold)) {
    return [{
      triggered: true,
      details: `Irradiance ${weather.irradiance_wm2} W/m² ${rule.operator} ${rule.threshold} W/m²`,
      currentValue: weather.irradiance_wm2,
    }];
  }
  return [];
}

/**
 * inverter_offline: Check if inverter power ratio < threshold.
 */
function evaluateInverterOffline(rule, stationId) {
  const inverters = getInvertersForStation(stationId);
  const triggered = [];

  for (const inv of inverters) {
    const strings = getStringsForInverter(inv.id);
    let totalPower = 0;
    let totalRated = 0;

    for (const s of strings) {
      const pd = getLatestPowerDataForString(s.id);
      if (pd) {
        totalPower += pd.power_w;
        totalRated += s.rated_power_w;
      }
    }

    if (totalRated === 0) continue;
    const powerRatio = totalPower / totalRated;

    if (compare(powerRatio, rule.operator, rule.threshold)) {
      triggered.push({
        triggered: true,
        details: `Inverter ${inv.name} power_ratio=${powerRatio.toFixed(4)} ${rule.operator} ${rule.threshold}`,
        currentValue: powerRatio,
        inverterName: inv.name,
      });
    }
  }
  return triggered;
}

/**
 * string_mismatch: Check if power ratio difference between strings of same inverter > threshold.
 */
function evaluateStringMismatch(rule, stationId) {
  const inverters = getInvertersForStation(stationId);
  const triggered = [];

  for (const inv of inverters) {
    const strings = getStringsForInverter(inv.id);
    const ratios = [];

    for (const s of strings) {
      const pd = getLatestPowerDataForString(s.id);
      if (pd && pd.power_w > 0) {
        ratios.push({ name: s.name, ratio: pd.power_w / s.rated_power_w });
      }
    }

    if (ratios.length < 2) continue;

    let maxRatio = -Infinity;
    let minRatio = Infinity;
    let maxName = '';
    let minName = '';

    for (const r of ratios) {
      if (r.ratio > maxRatio) { maxRatio = r.ratio; maxName = r.name; }
      if (r.ratio < minRatio) { minRatio = r.ratio; minName = r.name; }
    }

    const diff = maxRatio - minRatio;
    if (compare(diff, rule.operator, rule.threshold)) {
      triggered.push({
        triggered: true,
        details: `Inverter ${inv.name}: ${maxName}(${maxRatio.toFixed(3)}) vs ${minName}(${minRatio.toFixed(3)}), diff=${diff.toFixed(3)} ${rule.operator} ${rule.threshold}`,
        currentValue: diff,
        inverterName: inv.name,
      });
    }
  }
  return triggered;
}

/**
 * power_drop_sudden: Compare current power vs 15-min ago power.
 */
function evaluatePowerDropSudden(rule, stationId) {
  const strings = db.prepare(`
    SELECT s.id, s.name, s.rated_power_w
    FROM strings s
    JOIN inverters i ON s.inverter_id = i.id
    WHERE i.station_id = ?
  `).all(stationId);

  const triggered = [];
  for (const s of strings) {
    const current = getLatestPowerDataForString(s.id);
    const previous = getLatestPowerDataForString(s.id, '-15 minutes');

    if (!current || !previous || previous.power_w <= 0) continue;

    const dropRatio = current.power_w / previous.power_w;
    if (compare(dropRatio, rule.operator, rule.threshold)) {
      triggered.push({
        triggered: true,
        details: `${s.name}: power dropped from ${previous.power_w.toFixed(1)}W to ${current.power_w.toFixed(1)}W, ratio=${dropRatio.toFixed(3)} ${rule.operator} ${rule.threshold}`,
        currentValue: dropRatio,
        stringName: s.name,
      });
    }
  }
  return triggered;
}

/**
 * voltage_abnormal: Check voltage deviation from expected range.
 * Uses the threshold as a multiplier: checks if voltage deviates
 * significantly from the nominal ~600V range.
 */
function evaluateVoltageAbnormal(rule, stationId) {
  const strings = db.prepare(`
    SELECT s.id, s.name, s.rated_power_w
    FROM strings s
    JOIN inverters i ON s.inverter_id = i.id
    WHERE i.station_id = ?
  `).all(stationId);

  const triggered = [];
  for (const s of strings) {
    const pd = getLatestPowerDataForString(s.id);
    if (!pd || pd.voltage_v <= 0 || pd.power_w <= 0) continue;

    // Check if voltage is abnormally high or low relative to nominal ~850V
    // This matches the vmpString constant in utils/solarCalc.js
    // threshold acts as deviation multiplier
    const nominalVoltage = 850;
    const expectedMin = nominalVoltage / rule.threshold;
    const expectedMax = nominalVoltage * rule.threshold;

    if (pd.voltage_v < expectedMin || pd.voltage_v > expectedMax) {
      const deviation = pd.voltage_v > expectedMax
        ? (pd.voltage_v / expectedMax).toFixed(3)
        : (expectedMin / pd.voltage_v).toFixed(3);
      triggered.push({
        triggered: true,
        details: `${s.name}: voltage=${pd.voltage_v.toFixed(1)}V outside range [${expectedMin.toFixed(0)}, ${expectedMax.toFixed(0)}]V, deviation=${deviation}`,
        currentValue: pd.voltage_v,
        stringName: s.name,
      });
    }
  }
  return triggered;
}

// ---------------------------------------------------------------------------
// Rule type → evaluator mapping
// ---------------------------------------------------------------------------
const evaluators = {
  string_low_power: evaluateStringLowPower,
  string_zero_output: evaluateStringZeroOutput,
  temperature_high: evaluateTemperatureHigh,
  irradiance_low: evaluateIrradianceLow,
  inverter_offline: evaluateInverterOffline,
  string_mismatch: evaluateStringMismatch,
  power_drop_sudden: evaluatePowerDropSudden,
  voltage_abnormal: evaluateVoltageAbnormal,
};

// ---------------------------------------------------------------------------
// Core evaluation function
// ---------------------------------------------------------------------------

function evaluateStation(stationId, ruleFilter = {}) {
  const whereClauses = ['enabled = 1'];
  const params = [];

  if (ruleFilter.station_id !== undefined) {
    if (ruleFilter.station_id === null) {
      whereClauses.push('station_id IS NULL');
    } else {
      whereClauses.push('station_id = ?');
      params.push(ruleFilter.station_id);
    }
  }

  const rules = db.prepare(
    `SELECT * FROM alert_rules WHERE ${whereClauses.join(' AND ')} ORDER BY id`
  ).all(...params);

  const results = [];

  for (const rule of rules) {
    const evaluator = evaluators[rule.type];
    if (!evaluator) {
      console.log(`[AlertEval] Unknown rule type: ${rule.type}`);
      continue;
    }

    const evalResults = evaluator(rule, stationId);

    if (evalResults.length === 0) {
      // Rule evaluated but no conditions were triggered
      getInsertEvaluationStmt().run(rule.id, stationId, 0, null, parseFloat(rule.threshold), 0);
    }

    for (const er of evalResults) {
      // Check cooldown
      if (isInCooldown(rule, stationId)) {
        results.push({
          ruleId: rule.id,
          ruleName: rule.name,
          ruleType: rule.type,
          stationId,
          triggered: false,
          reason: 'In cooldown period',
        });
        getInsertEvaluationStmt().run(rule.id, stationId, 0, er.currentValue, parseFloat(rule.threshold), 0);
        continue;
      }

      // Create alert
      let message = `[${rule.type.toUpperCase()}] ${rule.name}: ${er.details}`;
      try {
        const alert = alertService.create({
          station_id: stationId,
          type: rule.type,
          severity: rule.severity,
          message,
          status: 'active',
        });

        wsService.broadcast('created', { id: alert.id, station_id: stationId, type: rule.type, severity: rule.severity, message }, 'alerts', 'station_' + stationId);

        let workOrder = null;
        // Auto-create work order if configured
        if (rule.auto_create_workorder === 1) {
          try {
            workOrder = workorderService.create({
              title: `Auto: ${rule.name}`,
              description: message,
              type: 'defect_repair',
              priority: rule.severity === 'critical' ? 'high' : rule.severity === 'warning' ? 'medium' : 'low',
              station_id: stationId,
              alert_id: alert.id,
            });
          } catch (woErr) {
            console.error(`[AlertEval] Failed to create work order for alert ${alert.id}: ${woErr.message}`);
          }
        }

        results.push({
          ruleId: rule.id,
          ruleName: rule.name,
          ruleType: rule.type,
          stationId,
          triggered: true,
          alertId: alert.id,
          workOrderId: workOrder ? workOrder.id : null,
          currentValue: er.currentValue,
          threshold: rule.threshold,
          operator: rule.operator,
          severity: rule.severity,
        });

        // Record evaluation history
        getInsertEvaluationStmt().run(rule.id, stationId, 1, er.currentValue, parseFloat(rule.threshold), 1);

        console.log(`[AlertEval] ⚠ Alert created: ${message}`);
        if (workOrder) {
          console.log(`[AlertEval]   ↳ Work order #${workOrder.id} created`);
        }
      } catch (alertErr) {
        console.error(`[AlertEval] Failed to create alert for rule ${rule.id}: ${alertErr.message}`);
        results.push({
          ruleId: rule.id,
          ruleName: rule.name,
          ruleType: rule.type,
          stationId,
          triggered: false,
          error: alertErr.message,
        });
        getInsertEvaluationStmt().run(rule.id, stationId, 0, er.currentValue, parseFloat(rule.threshold), 0);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
let intervalId = null;

function runEvaluation() {
  const startTime = Date.now();
  evaluationStatus.isRunning = true;
  evaluationStatus.error = null;

  const stations = stationService.getAll();
  const allResults = [];
  let alertCount = 0;
  let woCount = 0;

  console.log(`[AlertEval] === Starting evaluation at ${new Date().toISOString()} ===`);

  for (const station of stations) {
    // Evaluate per-station rules
    const stationResults = evaluateStation(station.id, { station_id: station.id });
    allResults.push(...stationResults);

    // Evaluate global rules (station_id = NULL)
    const globalResults = evaluateStation(station.id, { station_id: null });
    allResults.push(...globalResults);

    alertCount += stationResults.filter(r => r.triggered).length;
    alertCount += globalResults.filter(r => r.triggered).length;
    woCount += stationResults.filter(r => r.workOrderId).length;
    woCount += globalResults.filter(r => r.workOrderId).length;
  }

  const duration = Date.now() - startTime;
  evaluationStatus.isRunning = false;
  evaluationStatus.lastRunAt = new Date().toISOString();
  evaluationStatus.lastRunDurationMs = duration;
  evaluationStatus.lastRunResults = allResults;
  evaluationStatus.totalEvaluations += 1;
  evaluationStatus.totalAlertsCreated += alertCount;
  evaluationStatus.totalWorkOrdersCreated += woCount;

  const triggeredCount = allResults.filter(r => r.triggered).length;
  const cooldownCount = allResults.filter(r => r.reason === 'In cooldown period').length;

  console.log(`[AlertEval] === Evaluation complete in ${duration}ms ===`);
  console.log(`[AlertEval] Stations: ${stations.length}, Rules evaluated: ${allResults.length}, Triggered: ${triggeredCount}, Cooldown: ${cooldownCount}, Alerts: ${alertCount}, Work orders: ${woCount}`);
}

function startScheduler(intervalMinutes = 5) {
  if (intervalId) {
    console.log('[AlertEval] Scheduler already running, restarting...');
    stopScheduler();
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  console.log(`[AlertEval] Starting alert evaluation scheduler (every ${intervalMinutes} minutes)`);

  // Run immediately on start
  runEvaluation();

  // Then run on interval
  intervalId = setInterval(runEvaluation, intervalMs);
}

function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[AlertEval] Scheduler stopped');
  }
}

function getEvaluationStatus() {
  return {
    ...evaluationStatus,
    schedulerActive: intervalId !== null,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  startScheduler,
  stopScheduler,
  getEvaluationStatus,
  runEvaluation,
  evaluateStation,
  // Expose evaluators for testing
  evaluators,
};
