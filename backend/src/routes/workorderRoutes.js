const express = require('express');
const router = express.Router();
const workorderService = require('../services/workorderService');
const wsService = require('../services/websocketService');
const auditService = require('../services/auditService');
const { authenticate, requireStationAccess, requireRole } = require('../middleware/authMiddleware');

router.use(authenticate);
router.use(requireStationAccess);

function getUserId(req) {
  return req.user ? req.user.id : null;
}

// GET /api/workorders?status=&priority=&type=&assignee=&station_id=
router.get('/', (req, res) => {
  try {
    const { status, priority, type, assignee, station_id } = req.query;
    const filters = {};
    if (status) filters.status = status;
    if (priority) filters.priority = priority;
    if (type) filters.type = type;
    if (assignee) filters.assignee = assignee;
    if (station_id) filters.station_id = station_id;

    const workorders = workorderService.getAll(filters);
    res.json({ success: true, data: workorders });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/workorders/stats
router.get('/stats', (req, res) => {
  try {
    const stats = workorderService.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/workorders/:id
router.get('/:id', (req, res) => {
  try {
    const wo = workorderService.getById(req.params.id);
    if (!wo) {
      return res.status(404).json({ success: false, error: '工单不存在' });
    }
    res.json({ success: true, data: wo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/workorders — admin/manager/operator only (not viewer)
router.post('/', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const wo = workorderService.create(req.body);
    auditService.logAction(getUserId(req), 'create', 'work_order', wo.id, { title: wo.title, type: wo.type, priority: wo.priority }, req.ip);
    // Broadcast to "workorders" topic with optional room
    wsService.broadcast('created', wo, 'workorders', wo.station_id ? `station_${wo.station_id}` : null);
    res.status(201).json({ success: true, data: wo });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// PUT /api/workorders/:id — admin/manager/operator only (not viewer)
router.put('/:id', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const { status, assignee, ...otherData } = req.body;

    let wo;
    if (status) {
      // Capture old status BEFORE update for accurate audit trail
      const oldWo = workorderService.getById(req.params.id);
      if (!oldWo) return res.status(404).json({ success: false, error: 'Work order not found' });
      // If status is provided, use updateStatus for validation
      wo = workorderService.updateStatus(req.params.id, status, assignee);
      auditService.logAction(getUserId(req), 'status_change', 'work_order', wo.id, { from: oldWo.status, to: status, assignee }, req.ip);
      // If there are other fields to update
      if (Object.keys(otherData).length > 0) {
        wo = workorderService.update(req.params.id, otherData);
        auditService.logAction(getUserId(req), 'update', 'work_order', wo.id, { fields: Object.keys(otherData) }, req.ip);
      }
      // Broadcast status change
      wsService.broadcast('updated', wo, 'workorders', wo.station_id ? `station_${wo.station_id}` : null);
    } else {
      wo = workorderService.update(req.params.id, req.body);
      auditService.logAction(getUserId(req), 'update', 'work_order', wo.id, { fields: Object.keys(req.body) }, req.ip);
      // Broadcast update
      wsService.broadcast('updated', wo, 'workorders', wo.station_id ? `station_${wo.station_id}` : null);
    }

    res.json({ success: true, data: wo });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(400).json({ success: false, error: error.message });
  }
});

// DELETE /api/workorders/:id — admin/manager/operator only (not viewer)
router.delete('/:id', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const result = workorderService.delete(req.params.id);
    auditService.logAction(getUserId(req), 'delete', 'work_order', req.params.id, { title: result.title }, req.ip);
    wsService.broadcast('deleted', result, 'workorders');
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/workorders/:id/notes — admin/manager/operator only (not viewer)
router.post('/:id/notes', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const { content, created_by } = req.body;
    const note = workorderService.addNote(req.params.id, content, created_by);
    auditService.logAction(getUserId(req), 'add_note', 'work_order', req.params.id, { noteId: note.id }, req.ip);
    res.status(201).json({ success: true, data: note });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
