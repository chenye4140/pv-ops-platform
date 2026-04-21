const { db } = require('../models/database');

const sparePartsService = {
  // Get all spare parts with optional filters
  getAll(filters = {}) {
    let sql = `
      SELECT sp.*, s.name as station_name
      FROM spare_parts sp
      LEFT JOIN stations s ON sp.station_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (filters.station_id) {
      sql += ' AND sp.station_id = ?';
      params.push(filters.station_id);
    }
    if (filters.category) {
      sql += ' AND sp.category = ?';
      params.push(filters.category);
    }
    if (filters.status) {
      sql += ' AND sp.status = ?';
      params.push(filters.status);
    }
    if (filters.search) {
      sql += ' AND (sp.part_name LIKE ? OR sp.part_code LIKE ? OR sp.supplier LIKE ?)';
      const search = `%${filters.search}%`;
      params.push(search, search, search);
    }
    if (filters.low_stock) {
      sql += ' AND sp.quantity <= sp.min_quantity';
    }

    sql += ' ORDER BY sp.updated_at DESC';

    return db.prepare(sql).all(...params);
  },

  // Get a single spare part by ID
  getById(id) {
    return db.prepare(`
      SELECT sp.*, s.name as station_name
      FROM spare_parts sp
      LEFT JOIN stations s ON sp.station_id = s.id
      WHERE sp.id = ?
    `).get(id);
  },

  // Create a new spare part
  create(data) {
    const result = db.prepare(`
      INSERT INTO spare_parts (part_name, part_code, category, specification, unit, quantity, min_quantity, unit_price, supplier, station_id, location, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.part_name,
      data.part_code || null,
      data.category || 'general',
      data.specification || null,
      data.unit || 'pcs',
      data.quantity || 0,
      data.min_quantity || 5,
      data.unit_price || null,
      data.supplier || null,
      data.station_id || null,
      data.location || null,
      data.notes || null
    );

    // Auto-update status based on quantity
    this.updateStatus(result.lastInsertRowid);

    return this.getById(result.lastInsertRowid);
  },

  // Update a spare part
  update(id, data) {
    const fields = [];
    const values = [];

    const updatableFields = ['part_name', 'part_code', 'category', 'specification', 'unit', 'quantity', 'min_quantity', 'unit_price', 'supplier', 'station_id', 'location', 'status', 'notes'];
    for (const field of updatableFields) {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(data[field]);
      }
    }

    if (fields.length === 0) return this.getById(id);

    fields.push("updated_at = datetime('now')");
    values.push(id);

    db.prepare(`UPDATE spare_parts SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    // Auto-update status if quantity changed
    if (data.quantity !== undefined) {
      this.updateStatus(id);
    }

    return this.getById(id);
  },

  // Delete a spare part
  delete(id) {
    return db.prepare('DELETE FROM spare_parts WHERE id = ?').run(id);
  },

  // Record a stock transaction (in/out/adjustment)
  recordTransaction(data) {
    const part = this.getById(data.part_id);
    if (!part) throw new Error('Spare part not found');

    let newQuantity = part.quantity;
    if (data.transaction_type === 'in') {
      newQuantity += Math.abs(data.quantity);
    } else if (data.transaction_type === 'out') {
      newQuantity -= Math.abs(data.quantity);
      if (newQuantity < 0) throw new Error('Insufficient stock');
    } else {
      newQuantity = data.quantity;
    }

    db.prepare(`
      INSERT INTO spare_parts_transactions (part_id, transaction_type, quantity, reference_type, reference_id, performed_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.part_id,
      data.transaction_type,
      data.quantity,
      data.reference_type || 'manual',
      data.reference_id || null,
      data.performed_by || null,
      data.notes || null
    );

    db.prepare("UPDATE spare_parts SET quantity = ?, updated_at = datetime('now') WHERE id = ?").run(newQuantity, data.part_id);
    this.updateStatus(data.part_id);

    return this.getById(data.part_id);
  },

  // Get transaction history for a part
  getTransactions(partId, limit = 50) {
    return db.prepare(`
      SELECT * FROM spare_parts_transactions
      WHERE part_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(partId, limit);
  },

  // Auto-update status based on quantity vs min_quantity
  updateStatus(id) {
    const part = this.getById(id);
    if (!part) return;

    let newStatus = part.status;
    if (part.quantity <= 0) {
      newStatus = 'out_of_stock';
    } else if (part.quantity <= part.min_quantity) {
      newStatus = 'low_stock';
    } else if (part.status === 'out_of_stock' || part.status === 'low_stock') {
      newStatus = 'active';
    }

    if (newStatus !== part.status) {
      db.prepare("UPDATE spare_parts SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, id);
    }
  },

  // Get inventory summary statistics
  getStats() {
    const total = db.prepare('SELECT COUNT(*) as count FROM spare_parts').get();
    const lowStock = db.prepare('SELECT COUNT(*) as count FROM spare_parts WHERE quantity <= min_quantity AND quantity > 0').get();
    const outOfStock = db.prepare('SELECT COUNT(*) as count FROM spare_parts WHERE quantity <= 0').get();
    const totalValue = db.prepare('SELECT COALESCE(SUM(quantity * unit_price), 0) as value FROM spare_parts').get();

    return {
      total_parts: total.count,
      low_stock: lowStock.count,
      out_of_stock: outOfStock.count,
      total_inventory_value: totalValue.value,
    };
  },
};

module.exports = sparePartsService;
