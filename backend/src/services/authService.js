const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../models/database');

const JWT_SECRET = process.env.JWT_SECRET || 'pv-ops-platform-jwt-secret-key-2024-change-in-production';
const BCRYPT_COST = 12;

function generateToken(user, rememberMe = false) {
  const expiresIn = rememberMe ? '7d' : '24h';
  const payload = {
    userId: user.id,
    username: user.username,
    role: user.role,
    stationIds: user.station_ids ? JSON.parse(user.station_ids) : null,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn, algorithm: 'HS256' });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

function stripPassword(user) {
  if (!user) return null;
  const { password_hash, ...rest } = user;
  return rest;
}

async function createUser({ username, password, displayName, email, role, stationIds }) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    throw new Error('Username already exists');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const stationIdsJson = stationIds ? JSON.stringify(stationIds) : null;

  const result = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, email, role, station_ids)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(username, passwordHash, displayName || null, email || null, role || 'operator', stationIdsJson);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  return stripPassword(user);
}

async function authenticateUser(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    throw new Error('Invalid username or password');
  }

  if (!user.is_active) {
    throw new Error('Account is deactivated');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new Error('Invalid username or password');
  }

  // Update last login
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

  const token = generateToken(user);
  return { token, user: stripPassword(user) };
}

function getUserById(id) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return stripPassword(user);
}

function listUsers() {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  return users.map(stripPassword);
}

async function updateUser(id, updates) {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existing) {
    throw new Error('User not found');
  }

  const allowedFields = ['display_name', 'email', 'role', 'station_ids', 'is_active'];
  const fields = [];
  const values = [];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = ?`);
      if (field === 'station_ids') {
        values.push(updates[field] ? JSON.stringify(updates[field]) : null);
      } else {
        values.push(updates[field]);
      }
    }
  }

  if (updates.password) {
    fields.push('password_hash = ?');
    values.push(await bcrypt.hash(updates.password, BCRYPT_COST));
  }

  if (fields.length === 0) {
    return stripPassword(existing);
  }

  fields.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  return getUserById(id);
}

function deleteUser(id) {
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!existing) {
    throw new Error('User not found');
  }

  db.prepare("UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
  return { success: true };
}

async function seedDefaultAdmin() {
  const count = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (count.count > 0) {
    return;
  }

  const passwordHash = await bcrypt.hash('admin123', BCRYPT_COST);
  db.prepare(`
    INSERT INTO users (username, password_hash, display_name, role)
    VALUES (?, ?, ?, ?)
  `).run('admin', passwordHash, 'System Administrator', 'admin');

  console.log('✅ Default admin user created (username: admin, password: admin123)');
}

module.exports = {
  createUser,
  authenticateUser,
  verifyToken,
  generateToken,
  getUserById,
  listUsers,
  updateUser,
  deleteUser,
  seedDefaultAdmin,
};
