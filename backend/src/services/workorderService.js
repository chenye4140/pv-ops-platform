const { db } = require('../models/database');

const VALID_TYPES = ['defect_repair', 'routine_maintenance', 'inspection', 'cleaning', 'other'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const VALID_STATUSES = ['pending', 'assigned', 'in_progress', 'completed', 'closed'];

const STATUS_TRANSITIONS = {
  pending: ['assigned', 'closed'],
  assigned: ['in_progress', 'pending', 'closed'],
  in_progress: ['completed', 'pending'],
  completed: ['closed', 'in_progress'],
  closed: []
};

const workorderService = {
  getAll(filters = {}) {
    let sql = `
      SELECT wo.*, s.name as station_name, a.message as alert_message
      FROM work_orders wo
      LEFT JOIN stations s ON wo.station_id = s.id
      LEFT JOIN alerts a ON wo.alert_id = a.id
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
    if (filters.type) {
      sql += ' AND wo.type = ?';
      params.push(filters.type);
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

    const stmt = db.prepare(sql);
    return stmt.all(...params);
  },

  getById(id) {
    const wo = db.prepare(`
      SELECT wo.*, s.name as station_name, a.message as alert_message
      FROM work_orders wo
      LEFT JOIN stations s ON wo.station_id = s.id
      LEFT JOIN alerts a ON wo.alert_id = a.id
      WHERE wo.id = ?
    `).get(id);

    if (!wo) return null;

    // Fetch notes
    const notes = db.prepare(
      'SELECT * FROM work_order_notes WHERE work_order_id = ? ORDER BY created_at ASC'
    ).all(id);

    return { ...wo, notes };
  },

  create(data) {
    // Validate type
    if (!VALID_TYPES.includes(data.type)) {
      throw new Error(`Invalid work order type. Must be one of: ${VALID_TYPES.join(', ')}`);
    }

    // Validate priority
    const priority = data.priority || 'medium';
    if (!VALID_PRIORITIES.includes(priority)) {
      throw new Error(`Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
    }

    if (!data.title || data.title.trim() === '') {
      throw new Error('Work order title is required');
    }

    const result = db.prepare(
      `INSERT INTO work_orders (title, description, type, priority, status, assignee, station_id, alert_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      data.title.trim(),
      data.description || null,
      data.type,
      priority,
      data.status || 'pending',
      data.assignee || null,
      data.station_id || null,
      data.alert_id || null
    );

    return this.getById(result.lastInsertRowid);
  },

  updateStatus(id, newStatus, assignee) {
    const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
    if (!wo) {
      throw new Error('Work order not found');
    }

    // Validate new status
    if (!VALID_STATUSES.includes(newStatus)) {
      throw new Error(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    // Check valid transition
    const allowedTransitions = STATUS_TRANSITIONS[wo.status];
    if (!allowedTransitions.includes(newStatus)) {
      throw new Error(`Cannot transition from '${wo.status}' to '${newStatus}'. Allowed: ${allowedTransitions.join(', ') || 'none'}`);
    }

    let sql = "UPDATE work_orders SET status = ?, updated_at = datetime('now')";
    const params = [newStatus];

    if (newStatus === 'completed' || newStatus === 'closed') {
      sql += ", completed_at = datetime('now')";
    } else {
      sql += ", completed_at = NULL";
    }

    if (assignee) {
      sql += ', assignee = ?';
      params.push(assignee);
    }

    sql += ' WHERE id = ?';
    params.push(id);

    db.prepare(sql).run(...params);

    return this.getById(id);
  },

  update(id, data) {
    const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
    if (!wo) {
      throw new Error('Work order not found');
    }

    const fields = [];
    const params = [];

    if (data.title !== undefined) {
      fields.push('title = ?');
      params.push(data.title.trim());
    }
    if (data.description !== undefined) {
      fields.push('description = ?');
      params.push(data.description || null);
    }
    if (data.type !== undefined) {
      if (!VALID_TYPES.includes(data.type)) {
        throw new Error(`Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`);
      }
      fields.push('type = ?');
      params.push(data.type);
    }
    if (data.priority !== undefined) {
      if (!VALID_PRIORITIES.includes(data.priority)) {
        throw new Error(`Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
      }
      fields.push('priority = ?');
      params.push(data.priority);
    }
    if (data.assignee !== undefined) {
      fields.push('assignee = ?');
      params.push(data.assignee || null);
    }
    if (data.station_id !== undefined) {
      fields.push('station_id = ?');
      params.push(data.station_id || null);
    }
    if (data.alert_id !== undefined) {
      fields.push('alert_id = ?');
      params.push(data.alert_id || null);
    }

    if (fields.length === 0) {
      return this.getById(id);
    }

    fields.push("updated_at = datetime('now')");
    params.push(id);

    db.prepare(`UPDATE work_orders SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    return this.getById(id);
  },

  delete(id) {
    const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
    if (!wo) {
      throw new Error('Work order not found');
    }

    // Notes will be deleted via ON DELETE CASCADE
    db.prepare('DELETE FROM work_orders WHERE id = ?').run(id);

    return { id, deleted: true };
  },

  addNote(workOrderId, content, createdBy) {
    const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(workOrderId);
    if (!wo) {
      throw new Error('Work order not found');
    }

    if (!content || content.trim() === '') {
      throw new Error('Note content is required');
    }

    const result = db.prepare(
      'INSERT INTO work_order_notes (work_order_id, content, created_by) VALUES (?, ?, ?)'
    ).run(workOrderId, content.trim(), createdBy || null);

    return db.prepare('SELECT * FROM work_order_notes WHERE id = ?').get(result.lastInsertRowid);
  },

  getStats() {
    const total = db.prepare('SELECT COUNT(*) as count FROM work_orders').get().count;
    const byStatus = db.prepare(
      "SELECT status, COUNT(*) as count FROM work_orders GROUP BY status"
    ).all();
    const byPriority = db.prepare(
      "SELECT priority, COUNT(*) as count FROM work_orders GROUP BY priority"
    ).all();
    const byType = db.prepare(
      "SELECT type, COUNT(*) as count FROM work_orders GROUP BY type"
    ).all();

    return { total, byStatus, byPriority, byType };
  }
};

module.exports = workorderService;
