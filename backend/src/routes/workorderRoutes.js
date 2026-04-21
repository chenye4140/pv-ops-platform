const express = require('express');
const router = express.Router();
const workorderService = require('../services/workorderService');

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

// POST /api/workorders
router.post('/', (req, res) => {
  try {
    const wo = workorderService.create(req.body);
    res.status(201).json({ success: true, data: wo });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// PUT /api/workorders/:id
router.put('/:id', (req, res) => {
  try {
    const { status, assignee, ...otherData } = req.body;

    let wo;
    if (status) {
      // If status is provided, use updateStatus for validation
      wo = workorderService.updateStatus(req.params.id, status, assignee);
      // If there are other fields to update
      if (Object.keys(otherData).length > 0) {
        wo = workorderService.update(req.params.id, otherData);
      }
    } else {
      wo = workorderService.update(req.params.id, req.body);
    }

    res.json({ success: true, data: wo });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(400).json({ success: false, error: error.message });
  }
});

// DELETE /api/workorders/:id
router.delete('/:id', (req, res) => {
  try {
    const result = workorderService.delete(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/workorders/:id/notes
router.post('/:id/notes', (req, res) => {
  try {
    const { content, created_by } = req.body;
    const note = workorderService.addNote(req.params.id, content, created_by);
    res.status(201).json({ success: true, data: note });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
