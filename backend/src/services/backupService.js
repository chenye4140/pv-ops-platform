const fs = require('fs');
const path = require('path');
const { db } = require('../models/database');

const BACKUP_DIR = path.join(__dirname, '../../data/backups');

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const backupService = {
  // Create timestamped backup
  createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `pv_ops_backup_${timestamp}.db`;
    const backupPath = path.join(BACKUP_DIR, backupName);
    const dbPath = path.join(__dirname, '../../data/pv_ops.db');
    
    fs.copyFileSync(dbPath, backupPath);
    const stats = fs.statSync(backupPath);
    
    return {
      filename: backupName,
      path: backupPath,
      size: stats.size,
      sizeHuman: this.formatSize(stats.size),
      createdAt: stats.mtime,
    };
  },
  
  listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db'));
    return files.map(f => {
      const stats = fs.statSync(path.join(BACKUP_DIR, f));
      return {
        filename: f,
        size: stats.size,
        sizeHuman: this.formatSize(stats.size),
        createdAt: stats.mtime,
      };
    }).sort((a, b) => b.createdAt - a.createdAt);
  },
  
  restoreBackup(filename) {
    const backupPath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(backupPath)) throw new Error('Backup file not found');
    
    const dbPath = path.join(__dirname, '../../data/pv_ops.db');
    // Create safety backup of current DB first
    const safetyBackup = dbPath + '.pre_restore_' + Date.now() + '.bak';
    fs.copyFileSync(dbPath, safetyBackup);
    fs.copyFileSync(backupPath, dbPath);
    
    return { restored: filename, safetyBackup: path.basename(safetyBackup) };
  },
  
  deleteBackup(filename) {
    const backupPath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(backupPath)) throw new Error('Backup file not found');
    fs.unlinkSync(backupPath);
    return { deleted: filename };
  },
  
  getDatabaseStats() {
    const dbPath = path.join(__dirname, '../../data/pv_ops.db');
    const stats = fs.statSync(dbPath);
    
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableStats = tables.map(t => {
      const count = db.prepare(`SELECT COUNT(*) as count FROM "${t.name}"`).get();
      return { name: t.name, rowCount: count.count };
    });
    
    return {
      fileSize: stats.size,
      fileSizeHuman: this.formatSize(stats.size),
      lastModified: stats.mtime,
      tables: tableStats,
      totalTables: tables.length,
    };
  },
  
  formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  },
};

module.exports = backupService;
