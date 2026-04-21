const express = require('express');
const router = express.Router();
const sparePartsService = require('../services/sparePartsService');
const { authenticate } = require('../middleware/authMiddleware');
const auditService = require('../services/auditService');

router.use(authenticate);

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
router.post('/', (req, res) => {
  try {
    const part = sparePartsService.create(req.body);
    auditService.log({
      userId: req.user?.id,
      action: 'spare_part.created',
      resource: 'spare_parts',
      resource_id: part.id,
      details: `创建备件: ${part.part_name}`,
    });
    res.status(201).json({ success: true, data: part });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/spare-parts/:id — Update part
router.put('/:id', (req, res) => {
  try {
    const part = sparePartsService.update(req.params.id, req.body);
    if (!part) return res.status(404).json({ success: false, error: '备件不存在' });
    auditService.log({
      userId: req.user?.id,
      action: 'spare_part.updated',
      resource: 'spare_parts',
      resource_id: part.id,
      details: `更新备件: ${part.part_name}`,
    });
    res.json({ success: true, data: part });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/spare-parts/:id — Delete part
router.delete('/:id', (req, res) => {
  try {
    const part = sparePartsService.getById(req.params.id);
    sparePartsService.delete(req.params.id);
    if (part) {
      auditService.log({
        userId: req.user?.id,
        action: 'spare_part.deleted',
        resource: 'spare_parts',
        resource_id: req.params.id,
        details: `删除备件: ${part.part_name}`,
      });
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
    auditService.log({
      userId: req.user?.id,
      action: `spare_part.${transaction_type}`,
      resource: 'spare_parts',
      resource_id: part.id,
      details: `${transaction_type} 备件 ${part.part_name} 数量 ${quantity}`,
    });
    res.json({ success: true, data: part });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
