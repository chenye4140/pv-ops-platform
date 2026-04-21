/**
 * Export Service — Data export (CSV/Excel)
 *
 * Provides CSV export for:
 *   - Power data (generation history)
 *   - Alerts
 *   - Work orders
 *   - Inspections
 *   - Station overview
 */
const { db } = require('../models/database');

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCSV(headers, rows) {
  const BOM = '\uFEFF'; // UTF-8 BOM for Excel Chinese character support
  const headerLine = headers.map(h => escapeCSV(h)).join(',');
  const dataLines = rows.map(row =>
    headers.map(h => escapeCSV(row[h])).join(',')
  ).join('\n');
  return BOM + headerLine + '\n' + dataLines + '\n';
}

const exportService = {
  // -----------------------------------------------------------------------
  // Power Data Export
  // -----------------------------------------------------------------------
  exportPowerData(filters = {}) {
    let sql = `
      SELECT
        s.name as station_name,
        i.name as inverter_name,
        str.name as string_name,
        pd.timestamp,
        pd.power_w,
        pd.voltage_v,
        pd.current_a
      FROM power_data pd
      JOIN strings str ON pd.string_id = str.id
      JOIN inverters i ON str.inverter_id = i.id
      JOIN stations s ON i.station_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (filters.station_id) {
      sql += ' AND s.id = ?';
      params.push(filters.station_id);
    }
    if (filters.start_time) {
      sql += ' AND pd.timestamp >= ?';
      params.push(filters.start_time);
    }
    if (filters.end_time) {
      sql += ' AND pd.timestamp <= ?';
      params.push(filters.end_time);
    }
    if (filters.string_id) {
      sql += ' AND pd.string_id = ?';
      params.push(filters.string_id);
    }

    sql += ' ORDER BY pd.timestamp ASC LIMIT 50000';

    const rows = db.prepare(sql).all(...params);
    const headers = ['电站名称', '逆变器', '组串', '时间', '功率(W)', '电压(V)', '电流(A)'];
    const csvRows = rows.map(r => ({
      '电站名称': r.station_name,
      '逆变器': r.inverter_name,
      '组串': r.string_name,
      '时间': r.timestamp,
      '功率(W)': r.power_w,
      '电压(V)': r.voltage_v,
      '电流(A)': r.current_a,
    }));

    return { csv: toCSV(headers, csvRows), rowCount: rows.length, filename: 'power_data_export.csv' };
  },

  // -----------------------------------------------------------------------
  // Alerts Export
  // -----------------------------------------------------------------------
  exportAlerts(filters = {}) {
    let sql = `
      SELECT
        s.name as station_name,
        a.type,
        a.severity,
        a.message,
        a.status,
        a.created_at
      FROM alerts a
      JOIN stations s ON a.station_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (filters.station_id) {
      sql += ' AND a.station_id = ?';
      params.push(filters.station_id);
    }
    if (filters.status) {
      sql += ' AND a.status = ?';
      params.push(filters.status);
    }
    if (filters.severity) {
      sql += ' AND a.severity = ?';
      params.push(filters.severity);
    }
    if (filters.type) {
      sql += ' AND a.type = ?';
      params.push(filters.type);
    }

    sql += ' ORDER BY a.created_at DESC';

    const rows = db.prepare(sql).all(...params);
    const headers = ['电站名称', '告警类型', '严重程度', '告警内容', '状态', '触发时间'];
    const csvRows = rows.map(r => ({
      '电站名称': r.station_name,
      '告警类型': r.type,
      '严重程度': r.severity,
      '告警内容': r.message,
      '状态': r.status,
      '触发时间': r.created_at,
    }));

    return { csv: toCSV(headers, csvRows), rowCount: rows.length, filename: 'alerts_export.csv' };
  },

  // -----------------------------------------------------------------------
  // Work Orders Export
  // -----------------------------------------------------------------------
  exportWorkOrders(filters = {}) {
    let sql = `
      SELECT
        wo.id,
        wo.title,
        wo.type,
        wo.priority,
        wo.status,
        wo.assignee,
        s.name as station_name,
        wo.created_at,
        wo.updated_at,
        wo.completed_at
      FROM work_orders wo
      LEFT JOIN stations s ON wo.station_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (filters.status) {
      sql += ' AND wo.status = ?';
      params.push(filters.status);
    }
    if (filters.priority) {
      sql += ' AND wo.priority = ?';
      params.push(filters.priority);
    }
    if (filters.assignee) {
      sql += ' AND wo.assignee = ?';
      params.push(filters.assignee);
    }
    if (filters.station_id) {
      sql += ' AND wo.station_id = ?';
      params.push(filters.station_id);
    }

    sql += ' ORDER BY wo.created_at DESC';

    const rows = db.prepare(sql).all(...params);
    const headers = ['工单ID', '标题', '类型', '优先级', '状态', '负责人', '电站', '创建时间', '更新时间', '完成时间'];
    const typeMap = {
      defect_repair: '缺陷修复', routine_maintenance: '定期维护',
      inspection: '巡检', cleaning: '清洗', other: '其他'
    };
    const priorityMap = { low: '低', medium: '中', high: '高', urgent: '紧急' };
    const statusMap = { pending: '待处理', assigned: '已分配', in_progress: '进行中', completed: '已完成', closed: '已关闭' };

    const csvRows = rows.map(r => ({
      '工单ID': r.id,
      '标题': r.title,
      '类型': typeMap[r.type] || r.type,
      '优先级': priorityMap[r.priority] || r.priority,
      '状态': statusMap[r.status] || r.status,
      '负责人': r.assignee || '未分配',
      '电站': r.station_name || '-',
      '创建时间': r.created_at,
      '更新时间': r.updated_at,
      '完成时间': r.completed_at || '-',
    }));

    return { csv: toCSV(headers, csvRows), rowCount: rows.length, filename: 'workorders_export.csv' };
  },

  // -----------------------------------------------------------------------
  // Station Overview Export
  // -----------------------------------------------------------------------
  exportStationOverview(stationId) {
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) throw new Error('Station not found');

    // Overview stats
    const overview = db.prepare(`
      SELECT
        COUNT(DISTINCT i.id) as inverter_count,
        COUNT(DISTINCT str.id) as string_count,
        COUNT(DISTINCT CASE WHEN str.status = 'abnormal' THEN str.id END) as abnormal_count,
        COUNT(DISTINCT CASE WHEN a.status = 'active' THEN a.id END) as active_alerts,
        COUNT(DISTINCT CASE WHEN wo.status NOT IN ('completed', 'closed') THEN wo.id END) as open_workorders
      FROM stations st
      LEFT JOIN inverters i ON i.station_id = st.id
      LEFT JOIN strings str ON str.inverter_id = i.id
      LEFT JOIN alerts a ON a.station_id = st.id
      LEFT JOIN work_orders wo ON wo.station_id = st.id
      WHERE st.id = ?
    `).get(stationId);

    // Latest power summary
    const latestTs = db.prepare(`
      SELECT MAX(pd.timestamp) as ts FROM power_data pd
      JOIN strings s ON pd.string_id = s.id
      JOIN inverters i ON s.inverter_id = i.id
      WHERE i.station_id = ?
    `).get(stationId);

    let energySummary = { total_energy_kwh: 0, peak_power_kw: 0 };
    if (latestTs && latestTs.ts) {
      const latestDate = new Date(latestTs.ts);
      latestDate.setHours(0, 0, 0, 0);
      const latestStr = latestDate.toISOString();
      const nextDate = new Date(latestDate);
      nextDate.setDate(nextDate.getDate() + 1);

      energySummary = db.prepare(`
        SELECT
          SUM(pd.power_w) * 0.25 / 1000 as total_energy_kwh,
          MAX(pd.power_w) / 1000 as peak_power_kw
        FROM power_data pd
        JOIN strings s ON pd.string_id = s.id
        JOIN inverters i ON s.inverter_id = i.id
        WHERE i.station_id = ? AND pd.timestamp >= ? AND pd.timestamp < ?
      `).get(stationId, latestStr, nextDate.toISOString());
    }

    const headers = ['指标', '数值'];
    const csvRows = [
      { '指标': '电站名称', '数值': station.name },
      { '指标': '装机容量(MW)', '数值': station.capacity_mw },
      { '指标': '位置', '数值': station.location },
      { '指标': '状态', '数值': station.status },
      { '指标': '逆变器数量', '数值': overview.inverter_count },
      { '指标': '组串总数', '数值': overview.string_count },
      { '指标': '异常组串', '数值': overview.abnormal_count },
      { '指标': '活跃告警', '数值': overview.active_alerts },
      { '指标': '未关闭工单', '数值': overview.open_workorders },
      { '指标': '今日发电量(kWh)', '数值': Math.round((energySummary.total_energy_kwh || 0) * 100) / 100 },
      { '指标': '峰值功率(kW)', '数值': Math.round((energySummary.peak_power_kw || 0) * 100) / 100 },
      { '指标': '导出时间', '数值': new Date().toISOString() },
    ];

    return { csv: toCSV(headers, csvRows), rowCount: csvRows.length, filename: `station_${stationId}_overview.csv` };
  },

  // -----------------------------------------------------------------------
  // Inspection Export
  // -----------------------------------------------------------------------
  exportInspections(stationId) {
    const inspections = db.prepare(`
      SELECT ins.*, s.name as station_name
      FROM inspections ins
      JOIN stations s ON ins.station_id = s.id
      WHERE ins.station_id = ?
      ORDER BY ins.created_at DESC
    `).all(stationId);

    const tasks = db.prepare(`
      SELECT t.*, ins.title as inspection_title
      FROM inspection_tasks t
      JOIN inspections ins ON t.inspection_id = ins.id
      WHERE t.station_id = ?
      ORDER BY t.created_at DESC
    `).all(stationId);

    const typeMap = { routine: '常规巡检', special: '专项巡检', emergency: '紧急巡检' };
    const statusMap = { active: '进行中', paused: '已暂停', completed: '已完成' };
    const taskStatusMap = { pending: '待执行', in_progress: '进行中', completed: '已完成', skipped: '已跳过' };

    // Inspections CSV
    const insHeaders = ['巡检ID', '标题', '类型', '电站', '频率', '负责人', '状态', '下次到期', '上次完成', '创建时间'];
    const insRows = inspections.map(r => ({
      '巡检ID': r.id,
      '标题': r.title,
      '类型': typeMap[r.type] || r.type,
      '电站': r.station_name,
      '频率': r.frequency || '一次性',
      '负责人': r.assignee || '未分配',
      '状态': statusMap[r.status] || r.status,
      '下次到期': r.next_due_date || '-',
      '上次完成': r.last_completed_date || '-',
      '创建时间': r.created_at,
    }));

    // Tasks CSV
    const taskHeaders = ['任务ID', '巡检计划', '标题', '状态', '负责人', '到期时间', '完成时间', '发现'];
    const taskRows = tasks.map(r => ({
      '任务ID': r.id,
      '巡检计划': r.inspection_title,
      '标题': r.title,
      '状态': taskStatusMap[r.status] || r.status,
      '负责人': r.assignee || '未分配',
      '到期时间': r.due_date || '-',
      '完成时间': r.completed_at || '-',
      '发现': r.findings || '-',
    }));

    return {
      inspections: { csv: toCSV(insHeaders, insRows), rowCount: insRows.length },
      tasks: { csv: toCSV(taskHeaders, taskRows), rowCount: taskRows.length },
      filename: `inspections_station_${stationId}.csv`,
    };
  },
};

module.exports = exportService;
