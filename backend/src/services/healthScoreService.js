const { db } = require('../models/database');

/**
 * Health Score Service — computes a composite health score (0-100) for PV stations.
 *
 * Formula: Base 100, then deduct based on factors:
 *   - Active alerts: critical = -15 each, warning = -5 each
 *   - Work order backlog: pending + in_progress = -3 each
 *   - Inverter offline rate: proportional deduction up to -20
 *   - String abnormal rate: proportional deduction up to -20
 *   - Performance Ratio deviation: proportional deduction up to -20
 * Minimum score = 0.
 *
 * Grade mapping: A (90-100), B (80-89), C (70-79), D (60-69), F (0-59)
 */

function getGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Get alert deduction for a station.
 * Critical alerts: -15 each, Warning alerts: -5 each.
 */
function getAlertFactor(stationId) {
  const rows = db.prepare(`
    SELECT severity, COUNT(*) as count
    FROM alerts
    WHERE station_id = ? AND status = 'active'
    GROUP BY severity
  `).all(stationId);

  const counts = { critical: 0, warning: 0 };
  rows.forEach(row => {
    if (counts.hasOwnProperty(row.severity)) {
      counts[row.severity] = row.count;
    }
  });

  const deduction = counts.critical * 15 + counts.warning * 5;
  return { deduction, critical: counts.critical, warning: counts.warning };
}

/**
 * Get work order backlog deduction.
 * Pending + in_progress: -3 each.
 */
function getWorkOrderFactor(stationId) {
  const result = db.prepare(`
    SELECT COUNT(*) as count
    FROM work_orders
    WHERE station_id = ? AND status IN ('pending', 'in_progress')
  `).get(stationId);

  const count = result ? result.count : 0;
  return { deduction: count * 3, backlog: count };
}

/**
 * Get inverter online rate deduction (proportional, up to -20).
 */
function getInverterFactor(stationId) {
  const total = db.prepare(
    'SELECT COUNT(*) as total FROM inverters WHERE station_id = ?'
  ).get(stationId);

  const online = db.prepare(
    "SELECT COUNT(*) as online FROM inverters WHERE station_id = ? AND status = 'active'"
  ).get(stationId);

  const totalInv = total ? total.total : 0;
  const onlineInv = online ? online.online : 0;

  if (totalInv === 0) {
    return { deduction: 0, rate: 100, online: 0, total: 0 };
  }

  const rate = (onlineInv / totalInv) * 100;
  // Deduction proportional: 0 deduction at 100%, up to -20 at 0%
  const deduction = Math.round(((100 - rate) / 100) * 20 * 10) / 10;

  return { deduction, rate: Math.round(rate * 10) / 10, online: onlineInv, total: totalInv };
}

/**
 * Get string health rate deduction (proportional, up to -20).
 */
function getStringFactor(stationId) {
  const total = db.prepare(`
    SELECT COUNT(*) as total
    FROM strings s
    JOIN inverters i ON s.inverter_id = i.id
    WHERE i.station_id = ?
  `).get(stationId);

  const healthy = db.prepare(`
    SELECT COUNT(*) as healthy
    FROM strings s
    JOIN inverters i ON s.inverter_id = i.id
    WHERE i.station_id = ? AND s.status = 'normal'
  `).get(stationId);

  const totalStr = total ? total.total : 0;
  const healthyStr = healthy ? healthy.healthy : 0;

  if (totalStr === 0) {
    return { deduction: 0, rate: 100, healthy: 0, total: 0 };
  }

  const rate = (healthyStr / totalStr) * 100;
  const deduction = Math.round(((100 - rate) / 100) * 20 * 10) / 10;

  return { deduction, rate: Math.round(rate * 10) / 10, healthy: healthyStr, total: totalStr };
}

/**
 * Get power performance ratio deduction (proportional, up to -20).
 * Uses KPI PR. Full 20-point deduction at PR=0, no deduction at PR>=100.
 */
function getPerformanceFactor(stationId) {
  const kpiService = require('./kpiService');
  const today = new Date().toISOString();
  const pr = kpiService.calculatePR(stationId, today);

  if (!pr || pr.pr === 0) {
    // No data — moderate deduction
    return { deduction: 10, pr: null };
  }

  // PR is 0-100 scale. At PR=100, deduction=0. At PR=0, deduction=20.
  const prValue = Math.min(pr.pr, 100);
  const deduction = Math.round(((100 - prValue) / 100) * 20 * 10) / 10;

  return { deduction, pr: pr.pr };
}

/**
 * Compute the composite health score for a single station.
 * @param {number} stationId
 * @returns {object|null} { stationId, stationName, score, grade, factors } or null
 */
function getStationHealthScore(stationId) {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
  if (!station) return null;

  const alertF = getAlertFactor(stationId);
  const woF = getWorkOrderFactor(stationId);
  const invF = getInverterFactor(stationId);
  const strF = getStringFactor(stationId);
  const perfF = getPerformanceFactor(stationId);

  const score = Math.max(0, Math.min(100,
    100
    - alertF.deduction
    - woF.deduction
    - invF.deduction
    - strF.deduction
    - perfF.deduction
  ));

  const finalScore = Math.round(score * 10) / 10;

  return {
    stationId: station.id,
    stationName: station.name,
    score: finalScore,
    grade: getGrade(finalScore),
    factors: {
      alertDeduction: alertF.deduction,
      criticalAlerts: alertF.critical,
      warningAlerts: alertF.warning,
      workOrderDeduction: woF.deduction,
      workOrderBacklog: woF.backlog,
      inverterDeduction: invF.deduction,
      inverterOnlineRate: invF.rate,
      inverterOnline: invF.online,
      inverterTotal: invF.total,
      stringDeduction: strF.deduction,
      stringHealthRate: strF.rate,
      healthyStrings: strF.healthy,
      totalStrings: strF.total,
      performanceDeduction: perfF.deduction,
      performanceRatio: perfF.pr,
    },
  };
}

/**
 * Compute health scores for all stations.
 * @returns {Array} Array of { stationId, stationName, score, grade, factors }
 */
function getAllStationHealthScores() {
  const stations = db.prepare('SELECT * FROM stations ORDER BY id').all();

  return stations
    .map(station => getStationHealthScore(station.id))
    .filter(Boolean);
}

module.exports = {
  getStationHealthScore,
  getAllStationHealthScores,
};
