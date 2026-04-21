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
  `);
}

module.exports = { db, initDatabase };
