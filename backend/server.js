require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { initDatabase } = require('./src/models/database');
const authService = require('./src/services/authService');
const wsService = require('./src/services/websocketService');
const forecastAutoGenerate = require('./src/services/forecastAutoGenerate');
const alertEvaluationScheduler = require('./src/services/alertEvaluationScheduler');
const autoBackupScheduler = require('./src/services/autoBackupScheduler');
const liveDataSimulator = require('./src/services/liveDataSimulator');
const { apiLimiter, authLimiter, backupLimiter } = require('./src/middleware/rateLimiter');

// Initialize database and seed default admin
initDatabase();
authService.seedDefaultAdmin().catch((err) => {
  console.error('Error seeding default admin:', err.message);
});

// Auto-generate forecasts for all active stations on startup (3 days ahead, with 5s delay after DB init)
setTimeout(() => {
  forecastAutoGenerate.generateMultiDayForecasts(3).catch((err) => {
    console.error('[Startup] Forecast auto-generation failed:', err.message);
    // Fallback to single-day if multi-day fails
    forecastAutoGenerate.generateForecastsForAllStations().catch((err2) => {
      console.error('[Startup] Fallback forecast generation also failed:', err2.message);
    });
  });
}, 5000);

// Schedule daily forecast regeneration at 23:00 (3 days ahead)
const dailyForecast = forecastAutoGenerate.scheduleDailyForecast(23, 0);

// Schedule daily auto-backup at 02:00 AM (keeps last 10 backups)
const dailyBackup = autoBackupScheduler.scheduleDailyBackup(2, 0);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth routes (login/register don't require auth, user management does)
const authRoutes = require('./src/routes/authRoutes');
app.use('/api/auth', authLimiter, authRoutes);

// Audit routes (require admin auth - handled in routes)
const auditRoutes = require('./src/routes/auditRoutes');
app.use('/api/audit', auditRoutes);

// General API rate limiter for all remaining routes
app.use('/api', apiLimiter);

// Backup rate limiter (expensive disk I/O operations)
app.use('/api/backup', backupLimiter);

// Existing routes
const stationRoutes = require('./src/routes/stationRoutes');
const powerRoutes = require('./src/routes/powerRoutes');
const alertRoutes = require('./src/routes/alertRoutes');
const weatherRoutes = require('./src/routes/weatherRoutes');
const analysisRoutes = require('./src/routes/analysisRoutes');
const reportRoutes = require('./src/routes/reportRoutes');
const stringRoutes = require('./src/routes/stringRoutes');
const workorderRoutes = require('./src/routes/workorderRoutes');
const sparePartsRoutes = require('./src/routes/sparePartsRoutes');
const alertRuleRoutes = require('./src/routes/alertRuleRoutes');
const exportRoutes = require('./src/routes/exportRoutes');
const inspectionRoutes = require('./src/routes/inspectionRoutes');
const forecastRoutes = require('./src/routes/forecastRoutes');
const forecastEnhancedRoutes = require('./src/routes/forecastEnhancedRoutes');
const kpiRoutes = require('./src/routes/kpiRoutes');
const backupRoutes = require('./src/routes/backupRoutes');
const notificationRoutes = require('./src/routes/notificationRoutes');

app.use('/api/stations', stationRoutes);
app.use('/api/power-data', powerRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/weather', weatherRoutes);
app.use('/api/analysis', analysisRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/strings', stringRoutes);
app.use('/api/workorders', workorderRoutes);
app.use('/api/spare-parts', sparePartsRoutes);

// Alert rule evaluation status endpoint — must be BEFORE the /api/alert-rules router
// so it doesn't get caught by the /:id parametric route
app.get('/api/alert-rules/evaluation-status', (req, res) => {
  try {
    const status = alertEvaluationScheduler.getEvaluationStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use('/api/alert-rules', alertRuleRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/inspections', inspectionRoutes);
app.use('/api/forecast', forecastRoutes);
app.use('/api/forecast', forecastEnhancedRoutes);
app.use('/api/kpi', kpiRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/notifications', notificationRoutes);
const healthScoreRoutes = require('./src/routes/healthScoreRoutes');
const alertAnalysisRoutes = require('./src/routes/alertAnalysisRoutes');
app.use('/api/health-score', healthScoreRoutes);
app.use('/api/alert-analysis', alertAnalysisRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Live simulator status endpoint
app.get('/api/live-simulator/status', (req, res) => {
  res.json({ success: true, data: liveDataSimulator.getStatus() });
});

// WebSocket stats endpoint (requires auth - handled in routes)
app.get('/api/ws/stats', (req, res) => {
  res.json({ success: true, data: wsService.getStats() });
});

// Serve uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'), (err) => {
    if (err) {
      res.status(404).json({ error: 'Not found' });
    }
  });
});

// Start Express server
const server = app.listen(PORT, () => {
  console.log(`PV Ops Platform backend running on http://localhost:${PORT}`);

  // Start the alert evaluation scheduler after the server is ready
  alertEvaluationScheduler.startScheduler(5);

  // Start live data simulator if enabled
  if (process.env.ENABLE_LIVE_SIMULATOR === 'true') {
    liveDataSimulator.start(60);
  }
});

// Start WebSocket server (non-blocking)
wsService.startWSServer().catch((err) => {
  console.error('WebSocket server failed to start:', err.message);
});

module.exports = app;
