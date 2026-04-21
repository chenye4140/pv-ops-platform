/**
 * Auto-Backup Scheduler
 *
 * Automatically creates database backups at scheduled intervals.
 * Uses setInterval pattern (same as forecastAutoGenerate).
 * Features:
 * - Daily scheduled backup at configurable time
 * - Auto-cleanup: keeps only last N backups
 * - One-click backup from server startup
 */
const backupService = require('./backupService');

const MAX_BACKUPS = 10; // Keep last 10 backups

/**
 * Create a backup and auto-cleanup old ones.
 * @returns {object} Backup result with cleanup info
 */
function createAutoBackup() {
  try {
    const result = backupService.createBackup();
    console.log(`[AutoBackup] Created backup: ${result.filename} (${result.sizeHuman})`);

    // Auto-cleanup: delete oldest backups beyond MAX_BACKUPS
    const backups = backupService.listBackups();
    let cleaned = 0;
    if (backups.length > MAX_BACKUPS) {
      const toDelete = backups.slice(MAX_BACKUPS);
      for (const backup of toDelete) {
        try {
          backupService.deleteBackup(backup.filename);
          cleaned++;
          console.log(`[AutoBackup] Cleaned up old backup: ${backup.filename}`);
        } catch (err) {
          console.warn(`[AutoBackup] Failed to cleanup ${backup.filename}: ${err.message}`);
        }
      }
    }

    return { ...result, cleanedCount: cleaned };
  } catch (error) {
    console.error('[AutoBackup] Failed to create backup:', error.message);
    throw error;
  }
}

/**
 * Set up a daily scheduled backup using setInterval.
 * @param {number} hour - Hour of day (0-23), default 2 (2:00 AM)
 * @param {number} minute - Minute of hour (0-59), default 0
 * @returns {object} { intervalId, nextRun }
 */
function scheduleDailyBackup(hour = 2, minute = 0) {
  function getNextTarget() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  function runAtNext() {
    const delay = getNextTarget().getTime() - Date.now();
    console.log(`[AutoBackup] Next scheduled backup at ${getNextTarget().toISOString()} (in ${Math.round(delay / 60000)} min)`);

    return setTimeout(() => {
      createAutoBackup();
      // Re-schedule for next day
      runAtNext();
    }, delay);
  }

  const timeoutId = runAtNext();
  return {
    timeoutId,
    nextRun: getNextTarget().toISOString(),
    schedule: `Daily at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

/**
 * Get auto-backup schedule info
 */
function getScheduleInfo() {
  const backups = backupService.listBackups();
  return {
    enabled: true,
    maxBackups: MAX_BACKUPS,
    currentBackups: backups.length,
    totalSizeHuman: backups.reduce((sum, b) => sum + b.size, 0),
    oldestBackup: backups.length > 0 ? backups[backups.length - 1].createdAt : null,
    newestBackup: backups.length > 0 ? backups[0].createdAt : null,
  };
}

module.exports = {
  createAutoBackup,
  scheduleDailyBackup,
  getScheduleInfo,
  MAX_BACKUPS,
};
