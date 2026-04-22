const express = require('express');
const router = express.Router();
const sparePartsService = require('../services/sparePartsService');
const { authenticate, requireRole, requireStationAccess } = require('../middleware/authMiddleware');
const auditService = require('../services/auditService');

router.use(authenticate);
router.use(requireStationAccess);

function getUserId(req) {
  return req.user ? req.user.id : null;
}

// GET /api/spare-parts — List all spare parts with filters
router.get('/', (req, res) => {
  try {
    const filters = {
      station_id: req.query.station_id,
      category: req.query.category,
      status: req.query.status,
      search: req.query.search,
      low_stock: req.query.low_stock === 'true',
    };
    const parts = sparePartsService.getAll(filters);
    res.json({ success: true, data: parts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/spare-parts/stats — Inventory summary
router.get('/stats', (req, res) => {
  try {
    const stats = sparePartsService.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/spare-parts/:id — Get single part
router.get('/:id', (req, res) => {
  try {
    const part = sparePartsService.getById(req.params.id);
    if (!part) return res.status(404).json({ success: false, error: '备件不存在' });
    res.json({ success: true, data: part });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/spare-parts/:id/transactions — Transaction history
router.get('/:id/transactions', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const transactions = sparePartsService.getTransactions(req.params.id, limit);
    res.json({ success: true, data: transactions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/spare-parts — Create new part
router.post('/', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const part = sparePartsService.create(req.body);
    auditService.logAction(getUserId(req), 'create', 'spare_part', part.id, { part_name: part.part_name, category: part.category }, req.ip);
    res.status(201).json({ success: true, data: part });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/spare-parts/:id — Update part
router.put('/:id', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const part = sparePartsService.update(req.params.id, req.body);
    if (!part) return res.status(404).json({ success: false, error: '备件不存在' });
    auditService.logAction(getUserId(req), 'update', 'spare_part', part.id, { part_name: part.part_name, fields: Object.keys(req.body) }, req.ip);
    res.json({ success: true, data: part });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/spare-parts/:id — Delete part
router.delete('/:id', requireRole('admin', 'manager', 'operator'), (req, res) => {
  try {
    const part = sparePartsService.getById(req.params.id);
    sparePartsService.delete(req.params.id);
    if (part) {
      auditService.logAction(getUserId(req), 'delete', 'spare_part', req.params.id, { part_name: part.part_name }, req.ip);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/spare-parts/:id/transaction — Record stock movement
router.post('/:id/transaction', (req, res) => {
  try {
    const { transaction_type, quantity, reference_type, reference_id, notes } = req.body;
    if (!transaction_type || quantity === undefined) {
      return res.status(400).json({ success: false, error: 'transaction_type and quantity required' });
    }
    const part = sparePartsService.recordTransaction({
      part_id: parseInt(req.params.id),
      transaction_type,
      quantity: parseInt(quantity),
      reference_type,
      reference_id,
      performed_by: req.user?.username,
      notes,
    });
    auditService.logAction(getUserId(req), transaction_type, 'spare_part', part.id, { part_name: part.part_name, quantity, transaction_type }, req.ip);
    res.json({ success: true, data: part });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
