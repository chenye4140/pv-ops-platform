const express = require('express');
const router = express.Router();
const backupService = require('../services/backupService');
const autoBackupScheduler = require('../services/autoBackupScheduler');
const auditService = require('../services/auditService');
const { authenticate, requireRole } = require('../middleware/authMiddleware');

router.use(authenticate);
router.use(requireRole('admin'));

function getUserId(req) {
  return req.user ? req.user.id : null;
}

// POST /api/backup/create
router.post('/create', (req, res) => {
  try {
    const result = backupService.createBackup();
    auditService.logAction(getUserId(req), 'create', 'backup', null, { filename: result.filename, size: result.sizeHuman }, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/backup/list
router.get('/list', (req, res) => {
  try {
    const backups = backupService.listBackups();
    res.json({ success: true, data: backups });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/backup/restore/:filename
router.post('/restore/:filename', (req, res) => {
  try {
    const result = backupService.restoreBackup(req.params.filename);
    auditService.logAction(getUserId(req), 'restore', 'backup', null, { filename: result.restored, safetyBackup: result.safetyBackup }, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

// DELETE /api/backup/delete/:filename
router.delete('/delete/:filename', (req, res) => {
  try {
    const result = backupService.deleteBackup(req.params.filename);
    auditService.logAction(getUserId(req), 'delete', 'backup', null, { filename: result.deleted }, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

// GET /api/backup/stats
router.get('/stats', (req, res) => {
  try {
    const stats = backupService.getDatabaseStats();
    const backups = backupService.listBackups();
    res.json({ success: true, data: { ...stats, backupCount: backups.length, lastBackup: backups[0] || null } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/backup/auto-backup/info
router.get('/auto-backup/info', (req, res) => {
  try {
    const info = autoBackupScheduler.getScheduleInfo();
    res.json({ success: true, data: info });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/backup/auto-backup/run
router.post('/auto-backup/run', (req, res) => {
  try {
    const result = autoBackupScheduler.createAutoBackup();
    auditService.logAction(getUserId(req), 'auto_backup', 'backup', null, { filename: result.filename, size: result.sizeHuman }, req.ip);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
