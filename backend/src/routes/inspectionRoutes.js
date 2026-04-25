const express = require('express');
const router = express.Router();
const inspectionService = require('../services/inspectionService');
const { authenticate, requireStationAccess, requireRole } = require('../middleware/authMiddleware');
const wsService = require('../services/websocketService');
const auditService = require('../services/auditService');

router.use(authenticate);
router.use(requireStationAccess);

function getUserId(req) {
  return req.user ? req.user.id : null;
}

// ===== Inspection Plans =====

// GET /api/inspections?station_id=&type=&status=&assignee=
router.get('/', (req, res) => {
  try {
    const filters = {};
    if (req.query.station_id) filters.station_id = parseInt(req.query.station_id);
    if (req.query.type) filters.type = req.query.type;
    if (req.query.status) filters.status = req.query.status;
    if (req.query.assignee) filters.assignee = req.query.assignee;

    const inspections = inspectionService.getAll(filters);
    res.json({ success: true, data: inspections });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/inspections/stats?station_id=
router.get('/stats', (req, res) => {
  try {
    const stationId = req.query.station_id ? parseInt(req.query.station_id) : undefined;
    const stats = inspectionService.getStats(stationId);
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/inspections/tasks?station_id=&status=&assignee=
// MUST be before /:id to avoid being captured by the :id param
router.get('/tasks', (req, res) => {
  try {
    const filters = {};
    if (req.query.station_id) filters.station_id = parseInt(req.query.station_id);
    if (req.query.status) filters.status = req.query.status;
    if (req.query.assignee) filters.assignee = req.query.assignee;

    const tasks = inspectionService.getTasks(filters);
    res.json({ success: true, data: tasks });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/inspections/:id
router.get('/:id', (req, res) => {
  try {
    const inspection = inspectionService.getById(req.params.id);
    if (!inspection) return res.status(404).json({ success: false, error: '巡检计划不存在' });
    res.json({ success: true, data: inspection });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/inspections
// POST /api/inspections — admin/manager/operator only (not viewer)
router.post('/', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const inspection = inspectionService.create(req.body);
    auditService.logAction(getUserId(req), 'create', 'inspection', inspection.id, { title: inspection.title, type: inspection.type, station_id: inspection.station_id }, req.ip);
    wsService.broadcast('created', inspection, 'inspections', inspection.station_id ? 'station_' + inspection.station_id : null);
    res.status(201).json({ success: true, data: inspection });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// PUT /api/inspections/:id
// PUT /api/inspections/:id — admin/manager/operator only (not viewer)
router.put('/:id', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const inspection = inspectionService.update(req.params.id, req.body);
    auditService.logAction(getUserId(req), 'update', 'inspection', req.params.id, { fields: Object.keys(req.body) }, req.ip);
    wsService.broadcast('updated', inspection, 'inspections', inspection.station_id ? 'station_' + inspection.station_id : null);
    res.json({ success: true, data: inspection });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(400).json({ success: false, error: error.message });
  }
});

// DELETE /api/inspections/:id
// DELETE /api/inspections/:id — admin/manager/operator only (not viewer)
router.delete('/:id', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const result = inspectionService.delete(req.params.id);
    auditService.logAction(getUserId(req), 'delete', 'inspection', req.params.id, { title: result.title }, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

// POST /api/inspections/process-due
// POST /api/inspections/process-due — admin/manager/operator only (not viewer)
router.post('/process-due', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const results = inspectionService.processDueInspections();
    auditService.logAction(getUserId(req), 'process_due', 'inspection', null, { processed_count: results.length }, req.ip);
    res.json({ success: true, data: results, count: results.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== Inspection Tasks =====

// GET /api/inspections/:id/tasks?status=&assignee=
router.get('/:id/tasks', (req, res) => {
  try {
    const filters = { inspection_id: parseInt(req.params.id) };
    if (req.query.status) filters.status = req.query.status;
    if (req.query.assignee) filters.assignee = req.query.assignee;

    const tasks = inspectionService.getTasks(filters);
    res.json({ success: true, data: tasks });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/inspections/:id/tasks
// POST /api/inspections/:id/tasks — admin/manager/operator only (not viewer)
router.post('/:id/tasks', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const task = inspectionService.addTask(parseInt(req.params.id), req.body);
    auditService.logAction(getUserId(req), 'create', 'inspection_task', task.id, { inspection_id: req.params.id, title: task.title }, req.ip);
    res.status(201).json({ success: true, data: task });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /api/inspections/tasks/:taskId
router.get('/tasks/:taskId', (req, res) => {
  try {
    const task = inspectionService.getTaskById(req.params.taskId);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });
    res.json({ success: true, data: task });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/inspections/tasks/:taskId/status
// PUT /api/inspections/tasks/:taskId/status — admin/manager/operator only (not viewer)
router.put('/tasks/:taskId/status', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const { status, findings } = req.body;
    if (!status) return res.status(400).json({ success: false, error: 'status is required' });

    const oldTask = inspectionService.getTaskById(req.params.taskId);
    const task = inspectionService.updateTaskStatus(req.params.taskId, status, findings);
    auditService.logAction(getUserId(req), 'status_change', 'inspection_task', req.params.taskId, { from: oldTask ? oldTask.status : null, to: status, findings }, req.ip);
    res.json({ success: true, data: task });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// DELETE /api/inspections/tasks/:taskId
// DELETE /api/inspections/tasks/:taskId — admin/manager/operator only (not viewer)
router.delete('/tasks/:taskId', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const result = inspectionService.deleteTask(req.params.taskId);
    auditService.logAction(getUserId(req), 'delete', 'inspection_task', req.params.taskId, { title: result.title }, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

module.exports = router;
