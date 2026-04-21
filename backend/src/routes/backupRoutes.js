const express = require('express');
const router = express.Router();
const backupService = require('../services/backupService');

// POST /api/backup/create
router.post('/create', (req, res) => {
  try {
    const result = backupService.createBackup();
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
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

// DELETE /api/backup/delete/:filename
router.delete('/delete/:filename', (req, res) => {
  try {
    const result = backupService.deleteBackup(req.params.filename);
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

module.exports = router;
