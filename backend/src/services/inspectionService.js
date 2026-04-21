/**
 * Inspection Service — Inspection plan & task management
 *
 * Manages:
 *   - Inspection plans (create, update, pause, complete)
 *   - Inspection tasks (generate from plans, track status, record findings)
 *   - Auto-generation of tasks based on plan frequency
 */
const { db } = require('../models/database');

const VALID_TYPES = ['routine', 'special', 'emergency'];
const VALID_FREQUENCIES = ['daily', 'weekly', 'monthly', 'once'];
const VALID_STATUSES = ['active', 'paused', 'completed'];
const VALID_TASK_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'];

const inspectionService = {
  // -----------------------------------------------------------------------
  // Inspection Plans
  // -----------------------------------------------------------------------
  getAll(filters = {}) {
    let sql = `
      SELECT ins.*, s.name as station_name
      FROM inspections ins
      JOIN stations s ON ins.station_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (filters.station_id) {
      sql += ' AND ins.station_id = ?';
      params.push(filters.station_id);
    }
    if (filters.type) {
      sql += ' AND ins.type = ?';
      params.push(filters.type);
    }
    if (filters.status) {
      sql += ' AND ins.status = ?';
      params.push(filters.status);
    }
    if (filters.assignee) {
      sql += ' AND ins.assignee = ?';
      params.push(filters.assignee);
    }

    sql += ' ORDER BY ins.created_at DESC';
    return db.prepare(sql).all(...params);
  },

  getById(id) {
    return db.prepare(`
      SELECT ins.*, s.name as station_name
      FROM inspections ins
      JOIN stations s ON ins.station_id = s.id
      WHERE ins.id = ?
    `).get(id);
  },

  create(data) {
    if (!data.title || !data.station_id) {
      throw new Error('title and station_id are required');
    }
    if (data.type && !VALID_TYPES.includes(data.type)) {
      throw new Error(`Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`);
    }
    if (data.frequency && !VALID_FREQUENCIES.includes(data.frequency)) {
      throw new Error(`Invalid frequency. Must be one of: ${VALID_FREQUENCIES.join(', ')}`);
    }

    // Calculate next_due_date based on frequency
    let nextDueDate = null;
    if (data.frequency === 'daily') {
      nextDueDate = new Date(Date.now() + 86400000).toISOString();
    } else if (data.frequency === 'weekly') {
      nextDueDate = new Date(Date.now() + 7 * 86400000).toISOString();
    } else if (data.frequency === 'monthly') {
      nextDueDate = new Date(Date.now() + 30 * 86400000).toISOString();
    } else if (data.frequency === 'once') {
      nextDueDate = data.due_date || new Date(Date.now() + 86400000).toISOString();
    }

    const result = db.prepare(`
      INSERT INTO inspections
        (title, description, type, station_id, frequency, assignee, status, next_due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.title,
      data.description || null,
      data.type || 'routine',
      data.station_id,
      data.frequency || 'once',
      data.assignee || null,
      data.status || 'active',
      nextDueDate
    );

    const inspection = this.getById(result.lastInsertRowid);

    // Auto-generate tasks for this inspection
    this.generateTasks(result.lastInsertRowid, data.task_titles || this.getDefaultTaskTitles(data.type));

    return inspection;
  },

  update(id, data) {
    const existing = this.getById(id);
    if (!existing) throw new Error('Inspection not found');

    const fields = [];
    const params = [];

    const updatable = ['title', 'description', 'type', 'frequency', 'assignee', 'status', 'next_due_date'];

    for (const key of updatable) {
      if (data[key] !== undefined) {
        if (key === 'type' && !VALID_TYPES.includes(data[key])) {
          throw new Error(`Invalid type`);
        }
        if (key === 'frequency' && !VALID_FREQUENCIES.includes(data[key])) {
          throw new Error(`Invalid frequency`);
        }
        if (key === 'status' && !VALID_STATUSES.includes(data[key])) {
          throw new Error(`Invalid status`);
        }
        fields.push(`${key} = ?`);
        params.push(data[key]);
      }
    }

    if (fields.length === 0) return this.getById(id);

    fields.push("updated_at = datetime('now')");
    params.push(id);

    db.prepare(`UPDATE inspections SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return this.getById(id);
  },

  delete(id) {
    const existing = this.getById(id);
    if (!existing) throw new Error('Inspection not found');
    // Tasks will be deleted via ON DELETE CASCADE
    db.prepare('DELETE FROM inspections WHERE id = ?').run(id);
    return { id, deleted: true };
  },

  // -----------------------------------------------------------------------
  // Inspection Tasks
  // -----------------------------------------------------------------------
  getTasks(filters = {}) {
    let sql = `
      SELECT t.*, ins.title as inspection_title, ins.frequency, s.name as station_name
      FROM inspection_tasks t
      JOIN inspections ins ON t.inspection_id = ins.id
      JOIN stations s ON t.station_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (filters.inspection_id) {
      sql += ' AND t.inspection_id = ?';
      params.push(filters.inspection_id);
    }
    if (filters.station_id) {
      sql += ' AND t.station_id = ?';
      params.push(filters.station_id);
    }
    if (filters.status) {
      sql += ' AND t.status = ?';
      params.push(filters.status);
    }
    if (filters.assignee) {
      sql += ' AND t.assignee = ?';
      params.push(filters.assignee);
    }

    sql += ' ORDER BY t.due_date ASC, t.created_at ASC';
    return db.prepare(sql).all(...params);
  },

  getTaskById(id) {
    return db.prepare(`
      SELECT t.*, ins.title as inspection_title, ins.frequency, s.name as station_name
      FROM inspection_tasks t
      JOIN inspections ins ON t.inspection_id = ins.id
      JOIN stations s ON t.station_id = s.id
      WHERE t.id = ?
    `).get(id);
  },

  updateTaskStatus(id, newStatus, findings) {
    const task = db.prepare('SELECT * FROM inspection_tasks WHERE id = ?').get(id);
    if (!task) throw new Error('Inspection task not found');
    if (!VALID_TASK_STATUSES.includes(newStatus)) {
      throw new Error(`Invalid task status. Must be one of: ${VALID_TASK_STATUSES.join(', ')}`);
    }

    let sql = "UPDATE inspection_tasks SET status = ?";
    const params = [newStatus];

    if (newStatus === 'completed') {
      sql += ", completed_at = datetime('now')";
    }
    if (findings) {
      sql += ', findings = ?';
      params.push(typeof findings === 'string' ? findings : JSON.stringify(findings));
    }

    sql += ' WHERE id = ?';
    params.push(id);

    db.prepare(sql).run(...params);
    return this.getTaskById(id);
  },

  addTask(inspectionId, data) {
    const inspection = this.getById(inspectionId);
    if (!inspection) throw new Error('Inspection not found');
    if (!data.title) throw new Error('Task title is required');

    const result = db.prepare(`
      INSERT INTO inspection_tasks
        (inspection_id, station_id, title, description, assignee, due_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      inspectionId,
      inspection.station_id,
      data.title,
      data.description || null,
      data.assignee || inspection.assignee || null,
      data.due_date || inspection.next_due_date || null
    );

    return this.getTaskById(result.lastInsertRowid);
  },

  deleteTask(id) {
    const task = db.prepare('SELECT * FROM inspection_tasks WHERE id = ?').get(id);
    if (!task) throw new Error('Inspection task not found');
    db.prepare('DELETE FROM inspection_tasks WHERE id = ?').run(id);
    return { id, deleted: true };
  },

  // -----------------------------------------------------------------------
  // Task Generation
  // -----------------------------------------------------------------------
  generateTasks(inspectionId, taskTitles) {
    const inspection = this.getById(inspectionId);
    if (!inspection) throw new Error('Inspection not found');

    const insertTask = db.prepare(`
      INSERT INTO inspection_tasks (inspection_id, station_id, title, description, assignee, due_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const title of taskTitles) {
      insertTask.run(
        inspectionId,
        inspection.station_id,
        title,
        null,
        inspection.assignee || null,
        inspection.next_due_date || null
      );
    }
  },

  getDefaultTaskTitles(type) {
    switch (type) {
      case 'routine':
        return [
          '检查光伏组件外观',
          '检查组串电流电压',
          '检查逆变器运行状态',
          '检查接线盒与电缆',
          '检查支架与基础',
          '检查围栏与安防',
        ];
      case 'special':
        return [
          '红外热成像检测',
          'EL隐裂检测',
          '组串IV曲线测试',
          '绝缘电阻测试',
        ];
      case 'emergency':
        return [
          '故障现场勘察',
          '损坏组件评估',
          '安全检查',
          '临时防护措施',
        ];
      default:
        return ['巡检项目1', '巡检项目2'];
    }
  },

  // -----------------------------------------------------------------------
  // Automation: Generate tasks for due inspections
  // -----------------------------------------------------------------------
  processDueInspections() {
    const dueInspections = db.prepare(`
      SELECT * FROM inspections
      WHERE status = 'active'
        AND next_due_date IS NOT NULL
        AND next_due_date <= datetime('now')
    `).all();

    const results = [];
    for (const ins of dueInspections) {
      // Generate new tasks
      this.generateTasks(ins.id, this.getDefaultTaskTitles(ins.type));

      // Update next_due_date based on frequency
      let nextDue = null;
      const now = new Date();
      switch (ins.frequency) {
        case 'daily': nextDue = new Date(now.getTime() + 86400000).toISOString(); break;
        case 'weekly': nextDue = new Date(now.getTime() + 7 * 86400000).toISOString(); break;
        case 'monthly': nextDue = new Date(now.getTime() + 30 * 86400000).toISOString(); break;
        case 'once':
          db.prepare("UPDATE inspections SET status = 'completed', last_completed_date = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(ins.id);
          results.push({ id: ins.id, title: ins.title, status: 'completed' });
          continue;
      }

      db.prepare(`
        UPDATE inspections
        SET last_completed_date = datetime('now'),
            next_due_date = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(nextDue, ins.id);

      results.push({ id: ins.id, title: ins.title, nextDueDate: nextDue });
    }

    return results;
  },

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------
  getStats(stationId) {
    const baseSql = stationId ? 'WHERE station_id = ?' : '';
    const params = stationId ? [stationId] : [];

    const totalInspections = db.prepare(`SELECT COUNT(*) as count FROM inspections ${baseSql}`).get(...params).count;
    const activeInspections = db.prepare(`SELECT COUNT(*) as count FROM inspections ${baseSql ? baseSql + ' AND' : 'WHERE'} status = 'active'`).get(...params).count;

    const totalTasks = db.prepare(`SELECT COUNT(*) as count FROM inspection_tasks ${baseSql}`).get(...params).count;
    const tasksByStatus = db.prepare(`
      SELECT status, COUNT(*) as count FROM inspection_tasks
      ${baseSql} GROUP BY status
    `).all(...params);
    const tasksByType = db.prepare(`
      SELECT ins.type, COUNT(*) as count
      FROM inspection_tasks t
      JOIN inspections ins ON t.inspection_id = ins.id
      ${baseSql} GROUP BY ins.type
    `).all(...params);

    return {
      totalInspections,
      activeInspections,
      totalTasks,
      tasksByStatus,
      tasksByType,
    };
  },
};

module.exports = inspectionService;
