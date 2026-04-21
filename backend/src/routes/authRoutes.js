const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const auditService = require('../services/auditService');
const { authenticate, requireRole } = require('../middleware/authMiddleware');

// POST /api/auth/register - register new user (admin only)
router.post('/register', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { username, password, displayName, email, role, stationIds } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    const user = await authService.createUser({
      username,
      password,
      displayName,
      email,
      role,
      stationIds,
    });

    auditService.logAction(req.user.userId, 'register_user', 'users', user.id, { username: user.username }, req.ip);

    res.status(201).json({ success: true, data: user });
  } catch (error) {
    if (error.message === 'Username already exists') {
      return res.status(409).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }

    const result = await authService.authenticateUser(username, password);

    auditService.logAction(result.user.id, 'login', 'auth', null, { rememberMe }, req.ip);

    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message === 'Invalid username or password' || error.message === 'Account is deactivated') {
      return res.status(401).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, (req, res) => {
  auditService.logAction(req.user.userId, 'logout', 'auth', null, null, req.ip);
  res.json({ success: true, message: 'Logged out successfully' });
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  try {
    const user = authService.getUserById(req.user.userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/auth/users - list users (admin only)
router.get('/users', authenticate, requireRole('admin'), (req, res) => {
  try {
    const users = authService.listUsers();
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/auth/users/:id - update user (admin only)
router.put('/users/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const user = await authService.updateUser(req.params.id, req.body);
    auditService.logAction(req.user.userId, 'update_user', 'users', user.id, { updates: req.body }, req.ip);
    res.json({ success: true, data: user });
  } catch (error) {
    if (error.message === 'User not found') {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/auth/users/:id - deactivate user (admin only)
router.delete('/users/:id', authenticate, requireRole('admin'), (req, res) => {
  try {
    // Prevent admin from deactivating themselves
    if (parseInt(req.params.id, 10) === req.user.userId) {
      return res.status(400).json({ success: false, error: 'Cannot deactivate your own account' });
    }

    const result = authService.deleteUser(req.params.id);
    auditService.logAction(req.user.userId, 'deactivate_user', 'users', req.params.id, null, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message === 'User not found') {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
