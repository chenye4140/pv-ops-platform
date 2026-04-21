require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { initDatabase } = require('./src/models/database');
const authService = require('./src/services/authService');
const wsService = require('./src/services/websocketService');
const forecastAutoGenerate = require('./src/services/forecastAutoGenerate');

// Initialize database and seed default admin
initDatabase();
authService.seedDefaultAdmin().catch((err) => {
  console.error('Error seeding default admin:', err.message);
});

// Auto-generate forecasts for all active stations on startup (with 5s delay after DB init)
setTimeout(() => {
  forecastAutoGenerate.generateForecastsForAllStations().catch((err) => {
    console.error('[Startup] Forecast auto-generation failed:', err.message);
  });
}, 5000);

// Schedule daily forecast regeneration at 23:00
const dailyForecast = forecastAutoGenerate.scheduleDailyForecast(23, 0);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth routes (login/register don't require auth, user management does)
const authRoutes = require('./src/routes/authRoutes');
app.use('/api/auth', authRoutes);

// Audit routes (require admin auth - handled in routes)
const auditRoutes = require('./src/routes/auditRoutes');
app.use('/api/audit', auditRoutes);

// Existing routes
const stationRoutes = require('./src/routes/stationRoutes');
const powerRoutes = require('./src/routes/powerRoutes');
const alertRoutes = require('./src/routes/alertRoutes');
const weatherRoutes = require('./src/routes/weatherRoutes');
const analysisRoutes = require('./src/routes/analysisRoutes');
const reportRoutes = require('./src/routes/reportRoutes');
const stringRoutes = require('./src/routes/stringRoutes');
const workorderRoutes = require('./src/routes/workorderRoutes');
const alertRuleRoutes = require('./src/routes/alertRuleRoutes');
const exportRoutes = require('./src/routes/exportRoutes');
const inspectionRoutes = require('./src/routes/inspectionRoutes');
const forecastRoutes = require('./src/routes/forecastRoutes');

app.use('/api/stations', stationRoutes);
app.use('/api/power-data', powerRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/weather', weatherRoutes);
app.use('/api/analysis', analysisRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/strings', stringRoutes);
app.use('/api/workorders', workorderRoutes);
app.use('/api/alert-rules', alertRuleRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/inspections', inspectionRoutes);
app.use('/api/forecast', forecastRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// WebSocket stats endpoint (requires auth - handled in routes)
app.get('/api/ws/stats', (req, res) => {
  res.json({ success: true, data: wsService.getStats() });
});

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
});

// Start WebSocket server (non-blocking)
wsService.startWSServer().catch((err) => {
  console.error('WebSocket server failed to start:', err.message);
});

module.exports = app;
