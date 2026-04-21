const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/pv_ops.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      capacity_mw REAL NOT NULL,
      location TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inverters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      rated_power_kw REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      FOREIGN KEY (station_id) REFERENCES stations(id)
    );

    CREATE TABLE IF NOT EXISTS strings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inverter_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      panel_count INTEGER NOT NULL,
      rated_power_w REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'normal',
      FOREIGN KEY (inverter_id) REFERENCES inverters(id)
    );

    CREATE TABLE IF NOT EXISTS power_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      string_id INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      power_w REAL NOT NULL,
      voltage_v REAL NOT NULL,
      current_a REAL NOT NULL,
      FOREIGN KEY (string_id) REFERENCES strings(id)
    );

    CREATE TABLE IF NOT EXISTS weather_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      irradiance_wm2 REAL NOT NULL,
      temperature_c REAL NOT NULL,
      wind_speed_ms REAL NOT NULL,
      FOREIGN KEY (station_id) REFERENCES stations(id)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (station_id) REFERENCES stations(id)
    );

    -- Work Orders table
    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      assignee TEXT,
      station_id INTEGER,
      alert_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (station_id) REFERENCES stations(id),
      FOREIGN KEY (alert_id) REFERENCES alerts(id)
    );

    -- Work Order Notes table
    CREATE TABLE IF NOT EXISTS work_order_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_power_data_string_id ON power_data(string_id);
    CREATE INDEX IF NOT EXISTS idx_power_data_timestamp ON power_data(timestamp);
    CREATE INDEX IF NOT EXISTS idx_weather_data_station_id ON weather_data(station_id);
    CREATE INDEX IF NOT EXISTS idx_weather_data_timestamp ON weather_data(timestamp);
    CREATE INDEX IF NOT EXISTS idx_inverters_station_id ON inverters(station_id);
    CREATE INDEX IF NOT EXISTS idx_strings_inverter_id ON strings(inverter_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_station_id ON alerts(station_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
    CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status);
    CREATE INDEX IF NOT EXISTS idx_work_orders_station_id ON work_orders(station_id);
    CREATE INDEX IF NOT EXISTS idx_work_orders_assignee ON work_orders(assignee);
    CREATE INDEX IF NOT EXISTS idx_work_order_notes_work_order_id ON work_order_notes(work_order_id);

    -- Alert Rules table (configurable alert thresholds)
    CREATE TABLE IF NOT EXISTS alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL,            -- 'string_low_power', 'inverter_offline', 'temp_high', etc.
      metric TEXT NOT NULL,           -- 'power_ratio', 'temperature', 'irradiance', etc.
      operator TEXT NOT NULL DEFAULT '<', -- '<', '>', '<=', '>=', '==', '!='
      threshold REAL NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      station_id INTEGER,             -- NULL = global rule
      enabled INTEGER NOT NULL DEFAULT 1,
      cooldown_minutes INTEGER NOT NULL DEFAULT 30,
      auto_create_workorder INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (station_id) REFERENCES stations(id)
    );

    -- Inspections table (inspection plans)
    CREATE TABLE IF NOT EXISTS inspections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'routine',  -- 'routine', 'special', 'emergency'
      station_id INTEGER NOT NULL,
      frequency TEXT,                  -- 'daily', 'weekly', 'monthly', 'once'
      assignee TEXT,
      status TEXT NOT NULL DEFAULT 'active',  -- 'active', 'paused', 'completed'
      next_due_date TEXT,
      last_completed_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (station_id) REFERENCES stations(id)
    );

    -- Inspection Tasks table (individual inspection tasks)
    CREATE TABLE IF NOT EXISTS inspection_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inspection_id INTEGER NOT NULL,
      station_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'in_progress', 'completed', 'skipped'
      assignee TEXT,
      due_date TEXT,
      completed_at TEXT,
      findings TEXT,                   -- JSON: notes, photos, issues found
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (inspection_id) REFERENCES inspections(id) ON DELETE CASCADE,
      FOREIGN KEY (station_id) REFERENCES stations(id)
    );

    -- Power Forecast table
    CREATE TABLE IF NOT EXISTS power_forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL,
      forecast_date TEXT NOT NULL,
      forecast_hour INTEGER NOT NULL,   -- hour of day (0-23)
      predicted_power_kw REAL NOT NULL,
      predicted_energy_kwh REAL,
      confidence REAL DEFAULT 0.8,
      model_version TEXT DEFAULT 'baseline',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (station_id) REFERENCES stations(id)
    );

    -- New indexes
    CREATE INDEX IF NOT EXISTS idx_alert_rules_type ON alert_rules(type);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_station_id ON alert_rules(station_id);
    CREATE INDEX IF NOT EXISTS idx_inspections_station_id ON inspections(station_id);
    CREATE INDEX IF NOT EXISTS idx_inspections_status ON inspections(status);
    CREATE INDEX IF NOT EXISTS idx_inspection_tasks_inspection_id ON inspection_tasks(inspection_id);
    CREATE INDEX IF NOT EXISTS idx_inspection_tasks_status ON inspection_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_power_forecasts_station_date ON power_forecasts(station_id, forecast_date);
  `);
}

module.exports = { db, initDatabase };
