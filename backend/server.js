require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { initDatabase } = require('./src/models/database');

// Initialize database
initDatabase();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
const stationRoutes = require('./src/routes/stationRoutes');
const powerRoutes = require('./src/routes/powerRoutes');
const alertRoutes = require('./src/routes/alertRoutes');
const weatherRoutes = require('./src/routes/weatherRoutes');
const analysisRoutes = require('./src/routes/analysisRoutes');
const reportRoutes = require('./src/routes/reportRoutes');
const stringRoutes = require('./src/routes/stringRoutes');
const workorderRoutes = require('./src/routes/workorderRoutes');

app.use('/api/stations', stationRoutes);
app.use('/api/power-data', powerRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/weather', weatherRoutes);
app.use('/api/analysis', analysisRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/strings', stringRoutes);
app.use('/api/workorders', workorderRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

app.listen(PORT, () => {
  console.log(`PV Ops Platform backend running on http://localhost:${PORT}`);
});

module.exports = app;
