const { db, initDatabase } = require('../models/database');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

// ============================================================
// Configuration
// ============================================================
const STATION = {
  name: '西北光伏电站A',
  capacity_mw: 14.8,  // 80 strings × 336 panels × 550W = 14.78 MW DC
  location: '甘肃省酒泉市瓜州县',
  status: 'active'
};

const INVERTER_COUNT = 10;
const STRINGS_PER_INVERTER = 8;
const INVERTER_MODELS = ['Huawei SUN2000-100KTL', 'Sungrow SG100CX', 'Huawei SUN2000-100KTL', 'TMEIC TMY-100'];
const RATED_POWER_KW = 1000; // 1MW per inverter

const PANEL_COUNT = 336; // ~80% PR for 10MW station (80×336×550W ≈ 14.8MW DC installed)
const RATED_POWER_W = 550; // per panel

const DAYS = 7;
const INTERVAL_MINUTES = 15;
const POINTS_PER_DAY = (24 * 60) / INTERVAL_MINUTES; // 96 points

// Abnormal strings config (3-5 strings with reduced output)
const ABNORMAL_STRINGS = [
  { inverterIdx: 0, stringIdx: 2, reduction: 0.25 }, // 25% reduction
  { inverterIdx: 2, stringIdx: 5, reduction: 0.18 }, // 18% reduction
  { inverterIdx: 5, stringIdx: 0, reduction: 0.30 }, // 30% reduction
  { inverterIdx: 7, stringIdx: 4, reduction: 0.20 }, // 20% reduction
];

// ============================================================
// Solar irradiance simulation (Gaussian-like curve)
// ============================================================
function getIrradiance(hour, minute, dayOfYear) {
  // Solar time adjustment
  const solarNoon = 13.0; // Solar noon around 1 PM (UTC+8 timezone)
  const sunrise = 6.5;
  const sunset = 19.5;
  const time = hour + minute / 60;

  if (time < sunrise || time > sunset) return 0;

  // Peak irradiance varies by day (weather variation)
  const dayVariation = 0.85 + 0.15 * Math.sin(dayOfYear * 0.7 + 1.3);
  const peakIrradiance = 1000 * dayVariation;

  // Gaussian curve
  const sigma = (sunset - sunrise) / 4.5;
  const t = (time - solarNoon) / sigma;
  const irradiance = peakIrradiance * Math.exp(-0.5 * t * t);

  return Math.max(0, irradiance);
}

// ============================================================
// Temperature simulation
// ============================================================
function getTemperature(hour, minute, irradiance) {
  const time = hour + minute / 60;
  // Base temperature: desert area, hot during day, cool at night
  const baseTemp = 15 + 12 * Math.sin((time - 6) * Math.PI / 24);
  // Irradiance adds heat
  const irradianceEffect = (irradiance / 1000) * 8;
  return baseTemp + irradianceEffect;
}

// ============================================================
// Wind speed simulation
// ============================================================
function getWindSpeed(hour, minute) {
  const time = hour + minute / 60;
  const baseWind = 3 + 1.5 * Math.sin(time * Math.PI / 12);
  return Math.max(0.5, baseWind);
}

// ============================================================
// Random noise
// ============================================================
function randomNoise(mean = 0, std = 1) {
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z;
}

// ============================================================
// Calculate power for a string
// ============================================================
function calculateStringPower(irradiance, temperature, ratedPowerW, isAbnormal, reduction) {
  if (irradiance < 10) return 0;

  // STC: 1000 W/m², 25°C
  // Temperature coefficient: -0.35%/°C for silicon panels
  const tempCoeff = -0.0035;
  const tempFactor = 1 + tempCoeff * (temperature - 25);

  // Irradiance factor (linear)
  const irrFactor = irradiance / 1000;

  // System losses: ~15% (cables, soiling, inverter efficiency, etc.)
  const systemLoss = 0.85;

  // Panel mismatch factor
  const mismatch = 0.98;

  let power = ratedPowerW * irrFactor * tempFactor * systemLoss * mismatch;

  // Abnormal string reduction
  if (isAbnormal) {
    power *= (1 - reduction);
  }

  // Add random noise (~2% of rated power)
  const noise = randomNoise(0, ratedPowerW * 0.02);
  power = Math.max(0, power + noise);

  return power;
}

// ============================================================
// Calculate voltage and current from power
// ============================================================
function calculateVI(power, ratedPowerW) {
  if (power < 1) return { voltage: 0, current: 0 };

  // Realistic string voltage: ~20-30 panels in series at Vmp ~38V
  // String voltage typically 600-1000V for utility-scale installations
  const vmpString = 850; // nominal string voltage at MPP
  // Voltage varies slightly with temperature and irradiance (±8%)
  const voltage = vmpString * (0.92 + 0.08 * (power / ratedPowerW));

  // Current from power
  const current = power / voltage;

  return { voltage: Math.round(voltage * 100) / 100, current: Math.round(current * 1000) / 1000 };
}

// ============================================================
// Main generation function
// ============================================================
function generateMockData() {
  console.log('🔧 Initializing database...');
  initDatabase();

  console.log('🧹 Clearing existing data...');
  db.exec('DELETE FROM alerts');
  db.exec('DELETE FROM power_data');
  db.exec('DELETE FROM weather_data');
  db.exec('DELETE FROM strings');
  db.exec('DELETE FROM inverters');
  db.exec('DELETE FROM stations');

  // Reset autoincrement
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('stations', 'inverters', 'strings', 'power_data', 'weather_data', 'alerts')");

  // Also clear audit logs and users when regenerating
  try {
    db.exec('DELETE FROM audit_logs');
  } catch {}
  try {
    db.exec('DELETE FROM users');
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'users'");
  } catch {}

  // ============================================================
  // Create station
  // ============================================================
  console.log('📡 Creating station...');
  const stmtInsertStation = db.prepare(`
    INSERT INTO stations (name, capacity_mw, location, status)
    VALUES (?, ?, ?, ?)
  `);
  const stationInfo = stmtInsertStation.run(
    STATION.name, STATION.capacity_mw, STATION.location, STATION.status
  );
  const stationId = stationInfo.lastInsertRowid;
  console.log(`   Station created: ${STATION.name} (ID: ${stationId})`);

  // ============================================================
  // Create inverters
  // ============================================================
  console.log('🔌 Creating inverters...');
  const stmtInsertInverter = db.prepare(`
    INSERT INTO inverters (station_id, name, model, rated_power_kw, status)
    VALUES (?, ?, ?, ?, ?)
  `);

  const inverters = [];
  for (let i = 1; i <= INVERTER_COUNT; i++) {
    const model = INVERTER_MODELS[i % INVERTER_MODELS.length];
    const name = `INV-${String(i).padStart(2, '0')}`;
    const result = stmtInsertInverter.run(stationId, name, model, RATED_POWER_KW, 'active');
    inverters.push({ id: result.lastInsertRowid, name });
    console.log(`   ${name} (${model}) - ID: ${result.lastInsertRowid}`);
  }

  // ============================================================
  // Create strings and track abnormal ones
  // ============================================================
  console.log('🔗 Creating strings...');
  const stmtInsertString = db.prepare(`
    INSERT INTO strings (inverter_id, name, panel_count, rated_power_w, status)
    VALUES (?, ?, ?, ?, ?)
  `);

  // Build abnormal string lookup
  const abnormalMap = {};
  for (const ab of ABNORMAL_STRINGS) {
    const key = `${ab.inverterIdx}-${ab.stringIdx}`;
    abnormalMap[key] = ab.reduction;
  }

  const allStrings = [];
  for (let i = 0; i < INVERTER_COUNT; i++) {
    for (let j = 0; j < STRINGS_PER_INVERTER; j++) {
      const key = `${i}-${j}`;
      const isAbnormal = key in abnormalMap;
      const name = `INV-${String(i + 1).padStart(2, '0')}-STR-${String(j + 1).padStart(2, '0')}`;
      const result = stmtInsertString.run(
        inverters[i].id, name, PANEL_COUNT, RATED_POWER_W, isAbnormal ? 'abnormal' : 'normal'
      );
      allStrings.push({
        id: result.lastInsertRowid,
        name,
        inverterIdx: i,
        stringIdx: j,
        isAbnormal,
        reduction: abnormalMap[key] || 0
      });
      if (isAbnormal) {
        console.log(`   ⚠️ ${name} - ABNORMAL (${(abnormalMap[key] * 100).toFixed(0)}% reduction)`);
      }
    }
  }
  console.log(`   Total strings: ${allStrings.length} (${allStrings.filter(s => s.isAbnormal).length} abnormal)`);

  // ============================================================
  // Generate time series data
  // ============================================================
  console.log('📊 Generating time series data...');
  const stmtInsertPower = db.prepare(`
    INSERT INTO power_data (string_id, timestamp, power_w, voltage_v, current_a)
    VALUES (?, ?, ?, ?, ?)
  `);
  const stmtInsertWeather = db.prepare(`
    INSERT INTO weather_data (station_id, timestamp, irradiance_wm2, temperature_c, wind_speed_ms)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertPower = db.transaction((records) => {
    for (const r of records) {
      stmtInsertPower.run(r.stringId, r.timestamp, r.power, r.voltage, r.current);
    }
  });

  const insertWeather = db.transaction((records) => {
    for (const r of records) {
      stmtInsertWeather.run(r.stationId, r.timestamp, r.irradiance, r.temperature, r.windSpeed);
    }
  });

  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - DAYS);
  startDate.setHours(0, 0, 0, 0);

  const dayOfYear = Math.floor((startDate.getTime() - new Date(startDate.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24));

  let totalPowerRecords = 0;
  let totalWeatherRecords = 0;

  for (let day = 0; day < DAYS; day++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(currentDate.getDate() + day);
    const currentDayOfYear = dayOfYear + day;

    console.log(`   Processing day ${day + 1}/${DAYS}: ${currentDate.toISOString().split('T')[0]}`);

    const powerRecords = [];
    const weatherRecords = [];

    for (let point = 0; point < POINTS_PER_DAY; point++) {
      const totalMinutes = point * INTERVAL_MINUTES;
      const hour = Math.floor(totalMinutes / 60);
      const minute = totalMinutes % 60;

      const timestamp = new Date(currentDate);
      timestamp.setHours(hour, minute, 0, 0);
      const tsStr = timestamp.toISOString();

      // Weather
      const irradiance = getIrradiance(hour, minute, currentDayOfYear) + randomNoise(0, 15);
      const temperature = getTemperature(hour, minute, Math.max(0, irradiance)) + randomNoise(0, 0.5);
      const windSpeed = getWindSpeed(hour, minute) + randomNoise(0, 0.3);

      weatherRecords.push({
        stationId,
        timestamp: tsStr,
        irradiance: Math.round(Math.max(0, irradiance) * 10) / 10,
        temperature: Math.round(temperature * 10) / 10,
        windSpeed: Math.round(Math.max(0.1, windSpeed) * 100) / 100
      });

      // Power for each string
      for (const str of allStrings) {
        const panelPower = calculateStringPower(
          Math.max(0, irradiance),
          temperature,
          RATED_POWER_W,
          str.isAbnormal,
          str.reduction
        );
        // Scale up from per-panel to full string (PANEL_COUNT panels in series)
        const power = panelPower * PANEL_COUNT;
        const { voltage, current } = calculateVI(power, RATED_POWER_W * PANEL_COUNT);

        powerRecords.push({
          stringId: str.id,
          timestamp: tsStr,
          power: Math.round(power * 100) / 100,
          voltage,
          current
        });
      }
    }

    insertPower(powerRecords);
    insertWeather(weatherRecords);
    totalPowerRecords += powerRecords.length;
    totalWeatherRecords += weatherRecords.length;
  }

  console.log(`   Power data records: ${totalPowerRecords.toLocaleString()}`);
  console.log(`   Weather data records: ${totalWeatherRecords.toLocaleString()}`);

  // ============================================================
  // Generate alerts
  // ============================================================
  console.log('🚨 Generating alerts...');
  const stmtInsertAlert = db.prepare(`
    INSERT INTO alerts (station_id, type, severity, message, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const alertTemplates = [
    { type: 'string_low_power', severity: 'warning', message: '组串功率偏低，可能存在遮挡或故障' },
    { type: 'inverter_fault', severity: 'critical', message: '逆变器通讯中断' },
    { type: 'temperature_high', severity: 'warning', message: '环境温度过高，注意设备散热' },
    { type: 'string_open_circuit', severity: 'critical', message: '组串开路电压异常' },
    { type: 'low_irradiance', severity: 'info', message: '辐照度低于预期，可能为阴雨天气' },
    { type: 'grid_disconnect', severity: 'critical', message: '电网断开，逆变器停机' },
    { type: 'string_mismatch', severity: 'warning', message: '组串间功率差异过大' },
    { type: 'maintenance_due', severity: 'info', message: '设备定期维护提醒' },
  ];

  const alerts = [];
  for (const ab of ABNORMAL_STRINGS) {
    const alertTime = new Date(now);
    alertTime.setHours(10, 30, 0, 0);
    const str = allStrings.find(s => s.inverterIdx === ab.inverterIdx && s.stringIdx === ab.stringIdx);
    if (str) {
      alerts.push({
        stationId,
        type: 'string_low_power',
        severity: 'warning',
        message: `组串 ${str.name} 功率偏低 ${(ab.reduction * 100).toFixed(0)}%，请检查`,
        status: 'active',
        created_at: alertTime.toISOString()
      });
    }
  }

  // Add some general alerts
  for (let i = 0; i < 5; i++) {
    const template = alertTemplates[Math.floor(Math.random() * alertTemplates.length)];
    const alertTime = new Date(startDate);
    alertTime.setDate(alertTime.getDate() + Math.floor(Math.random() * DAYS));
    alertTime.setHours(8 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 60), 0, 0);

    alerts.push({
      stationId,
      type: template.type,
      severity: template.severity,
      message: template.message,
      status: i < 2 ? 'acknowledged' : 'active',
      created_at: alertTime.toISOString()
    });
  }

  for (const a of alerts) {
    stmtInsertAlert.run(a.stationId, a.type, a.severity, a.message, a.status, a.created_at);
  }
  console.log(`   Alerts generated: ${alerts.length}`);

  // ============================================================
  // Create default admin user
  // ============================================================
  console.log('👤 Creating default admin user...');
  const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('admin');
  if (adminCount.count === 0) {
    const adminPasswordHash = bcrypt.hashSync('admin123', 12);
    db.prepare(`
      INSERT INTO users (username, password_hash, display_name, role)
      VALUES (?, ?, ?, ?)
    `).run('admin', adminPasswordHash, 'System Administrator', 'admin');
    console.log('   ✅ Default admin user created (username: admin, password: admin123)');
  } else {
    console.log('   Admin user already exists, skipping.');
  }

  // ============================================================
  // Summary
  // ============================================================
  console.log('\n✅ Mock data generation complete!');
  console.log(`   Station: ${STATION.name}`);
  console.log(`   Capacity: ${STATION.capacity_mw} MW`);
  console.log(`   Inverters: ${INVERTER_COUNT}`);
  console.log(`   Strings: ${allStrings.length} (${allStrings.filter(s => s.isAbnormal).length} abnormal)`);
  console.log(`   Power data: ${totalPowerRecords.toLocaleString()} records`);
  console.log(`   Weather data: ${totalWeatherRecords.toLocaleString()} records`);
  console.log(`   Alerts: ${alerts.length}`);
}

// ============================================================
// Run if called directly
// ============================================================
if (require.main === module) {
  try {
    generateMockData();
    db.close();
  } catch (err) {
    console.error('❌ Error generating mock data:', err.message);
    process.exit(1);
  }
}

module.exports = { generateMockData };
