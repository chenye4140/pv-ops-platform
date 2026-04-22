/**
 * Seed Data Script — Populates the PV Ops Platform database with realistic test data
 *
 * Usage: cd /home/chenye/pv-ops-platform/backend && node scripts/seed_data.js
 */
const { db, initDatabase } = require('../src/models/database');
const path = require('path');
const solarCalc = require('../src/utils/solarCalc');

// ============================================================
// Configuration
// ============================================================
const STATIONS = [
  { name: '浙江海宁光伏电站', capacity_mw: 20, location: '浙江省嘉兴市海宁市', status: 'active' },
  { name: '江苏昆山光伏电站', capacity_mw: 15, location: '江苏省苏州市昆山市', status: 'active' },
  { name: '安徽合肥光伏电站', capacity_mw: 30, location: '安徽省合肥市肥西县', status: 'active' },
];

const INVERTER_CONFIGS = [3, 2, 3]; // inverters per station
const STRINGS_PER_INVERTER = [5, 4, 6, 5, 4, 6, 5, 4]; // varies per inverter
const INVERTER_MODELS = ['Huawei SUN2000-100KTL', 'Sungrow SG100CX', 'TMEIC TMY-100', 'Huawei SUN2000-175KTL'];
const RATED_POWER_KW = 100; // per inverter (scaled down for demo)
const PANEL_COUNT = 240;
const RATED_POWER_W = 550;

const DAYS = 7;
const INTERVAL_MINUTES = 60; // hourly data for seed (not 15-min to keep DB small)
const POINTS_PER_DAY = 24;

// Abnormal strings (some will have reduced output)
const ABNORMAL_STRINGS = [
  { stationIdx: 0, inverterIdx: 0, stringIdx: 2, reduction: 0.25 },
  { stationIdx: 0, inverterIdx: 1, stringIdx: 1, reduction: 0.18 },
  { stationIdx: 1, inverterIdx: 0, stringIdx: 3, reduction: 0.30 },
  { stationIdx: 2, inverterIdx: 1, stringIdx: 0, reduction: 0.20 },
  { stationIdx: 2, inverterIdx: 2, stringIdx: 4, reduction: 0.15 },
];

// Alert rule templates per station (8-10 rules)
const ALERT_RULE_TEMPLATES = [
  { name: '组串功率严重偏低', type: 'string_low_power', metric: 'power_ratio', operator: '<', threshold: 0.6, severity: 'critical', auto_create_workorder: true, cooldown_minutes: 15 },
  { name: '组串功率偏低', type: 'string_low_power', metric: 'power_ratio', operator: '<', threshold: 0.8, severity: 'warning', auto_create_workorder: false, cooldown_minutes: 30 },
  { name: '组串零输出（白天）', type: 'string_zero_output', metric: 'zero_output_strings', operator: '>', threshold: 0, severity: 'critical', auto_create_workorder: true, cooldown_minutes: 10 },
  { name: '环境温度过高', type: 'temperature_high', metric: 'temperature', operator: '>', threshold: 40, severity: 'warning', auto_create_workorder: false, cooldown_minutes: 60 },
  { name: '辐照度过低', type: 'irradiance_low', metric: 'irradiance', operator: '<', threshold: 100, severity: 'info', auto_create_workorder: false, cooldown_minutes: 120 },
  { name: '逆变器离线检测', type: 'inverter_offline', metric: 'power_ratio', operator: '<', threshold: 0.01, severity: 'critical', auto_create_workorder: true, cooldown_minutes: 5 },
  { name: '组串功率差异过大', type: 'string_mismatch', metric: 'power_ratio', operator: '>', threshold: 0.3, severity: 'warning', auto_create_workorder: false, cooldown_minutes: 30 },
  { name: '功率突降检测', type: 'power_drop_sudden', metric: 'power_ratio', operator: '<', threshold: 0.5, severity: 'critical', auto_create_workorder: true, cooldown_minutes: 20 },
  { name: '电压异常检测', type: 'voltage_abnormal', metric: 'power_ratio', operator: '>', threshold: 1.2, severity: 'warning', auto_create_workorder: false, cooldown_minutes: 30 },
  { name: '低辐照提示', type: 'irradiance_low', metric: 'irradiance', operator: '<', threshold: 50, severity: 'info', auto_create_workorder: false, cooldown_minutes: 180 },
];

// Work order templates
const WORKORDER_TEMPLATES = [
  { title: '组串#3功率异常检查', type: 'defect_repair', priority: 'high', description: '海宁电站组串INV-01-STR-03功率偏低约25%，需要现场检查是否存在遮挡或组件故障。' },
  { title: '逆变器#2定期维护', type: 'routine_maintenance', priority: 'medium', description: '按照维护计划对昆山电站2号逆变器进行季度维护，包括滤网清洁、接线检查。' },
  { title: '月度巡检-合肥电站A区', type: 'inspection', priority: 'medium', description: '对合肥电站A区进行全面巡检，包括组件外观、支架基础、电缆接线等。' },
  { title: '组件清洗-海宁电站B区', type: 'cleaning', priority: 'low', description: '海宁电站B区组件表面积灰严重，影响发电效率，安排清洗作业。' },
  { title: '组串开路故障修复', type: 'defect_repair', priority: 'urgent', description: '昆山电站组串INV-01-STR-04检测为开路状态，紧急派人排查修复。' },
  { title: '高温天气设备巡检', type: 'inspection', priority: 'high', description: '连续高温天气，需对所有电站设备进行特别巡检，重点关注逆变器散热。' },
  { title: '电缆绝缘测试', type: 'routine_maintenance', priority: 'medium', description: '合肥电站直流电缆年度绝缘电阻测试。' },
  { title: '杂草清理-电站周边', type: 'cleaning', priority: 'low', description: '雨季来临前清理电站周边杂草，防止影响通风和造成安全隐患。' },
];

const ASSIGNEES = ['张工', '李工', '王工', '赵工', '刘工'];

// Inspection plan templates
const INSPECTION_TEMPLATES = [
  { title: '日常巡检', type: 'routine', frequency: 'daily', description: '每日例行巡检，检查设备运行状态和环境状况。' },
  { title: '周度维护检查', type: 'routine', frequency: 'weekly', description: '每周设备维护检查，包括逆变器滤网清洁、接线检查等。' },
  { title: '月度全面巡检', type: 'routine', frequency: 'monthly', description: '每月全面巡检，覆盖所有组件、逆变器、支架、电缆等。' },
  { title: '季度红外检测', type: 'special', frequency: 'monthly', description: '每季度使用红外热成像仪检测组件热斑、接线盒过热等缺陷。' },
  { title: '年度安全评估', type: 'special', frequency: 'once', description: '年度电站安全评估，包括接地电阻测试、防雷检测等。' },
];

// ============================================================
// NOTE: Calculation functions are in ../src/utils/solarCalc.js
// Destructure locally for convenient use in the seed loop
// ============================================================
const { getIrradiance: calcIrradiance, getTemperature: calcTemperature, getWindSpeed: calcWindSpeed, randomNoise, calculateStringPower, calculateVI } = solarCalc;

// Seed-specific wrappers with tuned parameters for the 3-station demo
function getIrradiance(hour, minute, dayOfYear) {
  return calcIrradiance(hour, minute, dayOfYear, { sunrise: 6.0, sunset: 18.5, solarNoon: 12.5 });
}
function getTemperature(hour, minute, irradiance) {
  return calcTemperature(hour, minute, irradiance, { baseMin: 18, baseAmplitude: 10, irradianceEffect: 6 });
}
function getWindSpeed(hour, minute) {
  return calcWindSpeed(hour, minute, { baseWind: 2.5, amplitude: 1.2, minWind: 0.3 });
}

// ============================================================
// Main seed function
// ============================================================
function seedData() {
  console.log('🌱 PV Ops Platform - Seed Data Script');
  console.log('=====================================');

  console.log('\n🔧 Initializing database...');
  initDatabase();

  console.log('\n🧹 Clearing existing data...');
  // Delete in correct order (respecting foreign keys)
  db.exec('DELETE FROM power_forecasts');
  db.exec('DELETE FROM inspection_tasks');
  db.exec('DELETE FROM inspections');
  db.exec('DELETE FROM work_order_notes');
  db.exec('DELETE FROM work_orders');
  db.exec('DELETE FROM alert_rules');
  db.exec('DELETE FROM alerts');
  db.exec('DELETE FROM power_data');
  db.exec('DELETE FROM weather_data');
  db.exec('DELETE FROM strings');
  db.exec('DELETE FROM inverters');
  db.exec('DELETE FROM stations');

  // Reset autoincrement
  db.exec("DELETE FROM sqlite_sequence");

  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - DAYS);
  startDate.setHours(0, 0, 0, 0);
  const dayOfYear = Math.floor((startDate.getTime() - new Date(startDate.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24));

  const stmtInsertStation = db.prepare(`
    INSERT INTO stations (name, capacity_mw, location, status)
    VALUES (?, ?, ?, ?)
  `);
  const stmtInsertInverter = db.prepare(`
    INSERT INTO inverters (station_id, name, model, rated_power_kw, status)
    VALUES (?, ?, ?, ?, ?)
  `);
  const stmtInsertString = db.prepare(`
    INSERT INTO strings (inverter_id, name, panel_count, rated_power_w, status)
    VALUES (?, ?, ?, ?, ?)
  `);
  const stmtInsertPower = db.prepare(`
    INSERT INTO power_data (string_id, timestamp, power_w, voltage_v, current_a)
    VALUES (?, ?, ?, ?, ?)
  `);
  const stmtInsertWeather = db.prepare(`
    INSERT INTO weather_data (station_id, timestamp, irradiance_wm2, temperature_c, wind_speed_ms)
    VALUES (?, ?, ?, ?, ?)
  `);
  const stmtInsertAlertRule = db.prepare(`
    INSERT INTO alert_rules
      (name, description, type, metric, operator, threshold, severity, station_id, enabled, cooldown_minutes, auto_create_workorder)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtInsertWorkOrder = db.prepare(`
    INSERT INTO work_orders (title, description, type, priority, status, assignee, station_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtInsertInspection = db.prepare(`
    INSERT INTO inspections
      (title, description, type, station_id, frequency, assignee, status, next_due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtInsertTask = db.prepare(`
    INSERT INTO inspection_tasks (inspection_id, station_id, title, assignee, due_date)
    VALUES (?, ?, ?, ?, ?)
  `);

  // Batch insert helpers
  const insertPowerBatch = db.transaction((records) => {
    for (const r of records) {
      stmtInsertPower.run(r.stringId, r.timestamp, r.power, r.voltage, r.current);
    }
  });
  const insertWeatherBatch = db.transaction((records) => {
    for (const r of records) {
      stmtInsertWeather.run(r.stationId, r.timestamp, r.irradiance, r.temperature, r.windSpeed);
    }
  });

  // ============================================================
  // 1. Create stations
  // ============================================================
  console.log('\n📡 Creating stations...');
  const stationIds = [];
  for (const s of STATIONS) {
    const result = stmtInsertStation.run(s.name, s.capacity_mw, s.location, s.status);
    stationIds.push(result.lastInsertRowid);
    console.log(`   ✅ ${s.name} (${s.capacity_mw}MW) - ID: ${result.lastInsertRowid}`);
  }

  // ============================================================
  // 2. Create inverters and strings
  // ============================================================
  console.log('\n🔌 Creating inverters and strings...');
  const allStrings = []; // { id, stationIdx, inverterIdx, stringIdx, isAbnormal, reduction }
  let globalStringIdx = 0;

  for (let s = 0; s < STATIONS.length; s++) {
    const invCount = INVERTER_CONFIGS[s];
    const inverters = [];

    for (let i = 0; i < invCount; i++) {
      const model = INVERTER_MODELS[(s * 3 + i) % INVERTER_MODELS.length];
      const name = `INV-${String(i + 1).padStart(2, '0')}`;
      const invResult = stmtInsertInverter.run(stationIds[s], name, model, RATED_POWER_KW, 'active');
      inverters.push({ id: invResult.lastInsertRowid, name });

      const strCount = STRINGS_PER_INVERTER[globalStringIdx % STRINGS_PER_INVERTER.length];
      globalStringIdx++;

      for (let j = 0; j < strCount; j++) {
        const strName = `${name}-STR-${String(j + 1).padStart(2, '0')}`;
        const ab = ABNORMAL_STRINGS.find(a => a.stationIdx === s && a.inverterIdx === i && a.stringIdx === j);
        const isAbnormal = !!ab;
        const strResult = stmtInsertString.run(
          inverters[i].id, strName, PANEL_COUNT, RATED_POWER_W, isAbnormal ? 'abnormal' : 'normal'
        );
        allStrings.push({
          id: strResult.lastInsertRowid,
          stationIdx: s,
          inverterIdx: i,
          stringIdx: j,
          strName,
          isAbnormal,
          reduction: ab ? ab.reduction : 0,
        });
      }
    }
    console.log(`   ${STATIONS[s].name}: ${invCount} inverters, ${allStrings.filter(x => x.stationIdx === s).length} strings`);
  }
  console.log(`   Total strings: ${allStrings.length} (${allStrings.filter(s => s.isAbnormal).length} abnormal)`);

  // ============================================================
  // 3. Generate 7 days of power + weather data
  // ============================================================
  console.log('\n📊 Generating 7-day historical data...');
  let totalPowerRecords = 0;
  let totalWeatherRecords = 0;

  for (let day = 0; day < DAYS; day++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(currentDate.getDate() + day);
    const currentDayOfYear = dayOfYear + day;

    console.log(`   Day ${day + 1}/${DAYS}: ${currentDate.toISOString().split('T')[0]}`);

    const powerRecords = [];
    const weatherRecords = [];

    for (let hour = 0; hour < 24; hour++) {
      const timestamp = new Date(currentDate);
      timestamp.setHours(hour, 0, 0, 0);
      const tsStr = timestamp.toISOString();

      // Weather (per station)
      for (let s = 0; s < STATIONS.length; s++) {
        const irradiance = getIrradiance(hour, 0, currentDayOfYear) + randomNoise(0, 15);
        const temperature = getTemperature(hour, 0, Math.max(0, irradiance)) + randomNoise(0, 0.5);
        const windSpeed = getWindSpeed(hour, 0) + randomNoise(0, 0.3);

        weatherRecords.push({
          stationId: stationIds[s],
          timestamp: tsStr,
          irradiance: Math.round(Math.max(0, irradiance) * 10) / 10,
          temperature: Math.round(temperature * 10) / 10,
          windSpeed: Math.round(Math.max(0.1, windSpeed) * 100) / 100
        });
      }

      // Power data (per string)
      for (const str of allStrings) {
        const irradiance = getIrradiance(hour, 0, currentDayOfYear) + randomNoise(0, 10);
        const temperature = getTemperature(hour, 0, Math.max(0, irradiance)) + randomNoise(0, 0.3);

        const panelPower = calculateStringPower(
          Math.max(0, irradiance),
          temperature,
          RATED_POWER_W,
          str.isAbnormal,
          str.reduction
        );
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

    insertPowerBatch(powerRecords);
    insertWeatherBatch(weatherRecords);
    totalPowerRecords += powerRecords.length;
    totalWeatherRecords += weatherRecords.length;
  }
  console.log(`   Power records: ${totalPowerRecords.toLocaleString()}`);
  console.log(`   Weather records: ${totalWeatherRecords.toLocaleString()}`);

  // ============================================================
  // 4. Create alert rules (8-10 per station)
  // ============================================================
  console.log('\n⚙️ Creating alert rules...');
  let totalRules = 0;
  for (let s = 0; s < STATIONS.length; s++) {
    // Use 9 rules per station (mix of all severities)
    const rulesToCreate = ALERT_RULE_TEMPLATES.slice(0, 9);
    for (const rule of rulesToCreate) {
      stmtInsertAlertRule.run(
        rule.name,
        `${rule.name} - ${STATIONS[s].name}`,
        rule.type,
        rule.metric,
        rule.operator,
        rule.threshold,
        rule.severity,
        stationIds[s],
        1, // enabled
        rule.cooldown_minutes,
        rule.auto_create_workorder ? 1 : 0
      );
      totalRules++;
    }
    console.log(`   ${STATIONS[s].name}: ${rulesToCreate.length} rules`);
  }
  console.log(`   Total alert rules: ${totalRules}`);

  // ============================================================
  // 5. Create work orders (5-8)
  // ============================================================
  console.log('\n📋 Creating work orders...');
  const woTemplatesToUse = WORKORDER_TEMPLATES.slice(0, 7);
  const woStatuses = ['pending', 'assigned', 'in_progress', 'pending', 'assigned', 'in_progress', 'completed'];
  for (let i = 0; i < woTemplatesToUse.length; i++) {
    const wo = woTemplatesToUse[i];
    // Distribute across stations
    const stationIdx = i % STATIONS.length;
    const assignee = ASSIGNEES[i % ASSIGNEES.length];
    const status = woStatuses[i];

    // Set created_at to a few days ago
    const createdDate = new Date(now);
    createdDate.setDate(createdDate.getDate() - Math.floor(Math.random() * 5) - 1);
    createdDate.setHours(8 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 60), 0, 0);
    const createdStr = createdDate.toISOString();

    stmtInsertWorkOrder.run(
      wo.title,
      wo.description,
      wo.type,
      wo.priority,
      status,
      assignee,
      stationIds[stationIdx]
    );
    // Update created_at
    db.prepare("UPDATE work_orders SET created_at = ?, updated_at = ? WHERE id = (SELECT MAX(id) FROM work_orders)").run(createdStr, createdStr);

    console.log(`   WO #${i + 1}: ${wo.title} [${wo.priority}] -> ${assignee} @ ${STATIONS[stationIdx].name}`);
  }
  console.log(`   Total work orders: ${woTemplatesToUse.length}`);

  // ============================================================
  // 6. Create inspection plans (3-5)
  // ============================================================
  console.log('\n🔍 Creating inspection plans...');
  const inspToCreate = INSPECTION_TEMPLATES.slice(0, 4);
  for (let i = 0; i < inspToCreate.length; i++) {
    const insp = inspToCreate[i];
    const stationIdx = i % STATIONS.length;
    const assignee = ASSIGNEES[(i + 2) % ASSIGNEES.length];

    let nextDueDate;
    if (insp.frequency === 'daily') {
      nextDueDate = new Date(Date.now() + 86400000).toISOString();
    } else if (insp.frequency === 'weekly') {
      nextDueDate = new Date(Date.now() + 7 * 86400000).toISOString();
    } else if (insp.frequency === 'monthly') {
      nextDueDate = new Date(Date.now() + 30 * 86400000).toISOString();
    } else {
      nextDueDate = new Date(Date.now() + 90 * 86400000).toISOString();
    }

    const result = stmtInsertInspection.run(
      `${insp.title} - ${STATIONS[stationIdx].name}`,
      insp.description,
      insp.type,
      stationIds[stationIdx],
      insp.frequency,
      assignee,
      'active',
      nextDueDate
    );

    // Create default tasks for this inspection
    const taskTitles = ['检查光伏组件外观', '检查组串电流电压', '检查逆变器运行状态', '检查接线盒与电缆'];
    for (const title of taskTitles) {
      stmtInsertTask.run(
        result.lastInsertRowid,
        stationIds[stationIdx],
        title,
        assignee,
        nextDueDate
      );
    }

    console.log(`   ${insp.title} (${insp.frequency}) @ ${STATIONS[stationIdx].name}`);
  }
  console.log(`   Total inspection plans: ${inspToCreate.length}`);

  // ============================================================
  // Summary
  // ============================================================
  console.log('\n✅ Seed data generation complete!');
  console.log('=====================================');

  // Print summary
  const stationCount = db.prepare('SELECT COUNT(*) as count FROM stations').get().count;
  const inverterCount = db.prepare('SELECT COUNT(*) as count FROM inverters').get().count;
  const stringCount = db.prepare('SELECT COUNT(*) as count FROM strings').get().count;
  const powerCount = db.prepare('SELECT COUNT(*) as count FROM power_data').get().count;
  const weatherCount = db.prepare('SELECT COUNT(*) as count FROM weather_data').get().count;
  const alertRuleCount = db.prepare('SELECT COUNT(*) as count FROM alert_rules').get().count;
  const workOrderCount = db.prepare('SELECT COUNT(*) as count FROM work_orders').get().count;
  const inspectionCount = db.prepare('SELECT COUNT(*) as count FROM inspections').get().count;
  const taskCount = db.prepare('SELECT COUNT(*) as count FROM inspection_tasks').get().count;

  console.log(`📊 Stations:        ${stationCount}`);
  console.log(`🔌 Inverters:      ${inverterCount}`);
  console.log(`🔗 Strings:        ${stringCount}`);
  console.log(`⚡ Power data:     ${powerCount.toLocaleString()} records`);
  console.log(`🌤️ Weather data:   ${weatherCount.toLocaleString()} records`);
  console.log(`⚙️ Alert rules:    ${alertRuleCount}`);
  console.log(`📋 Work orders:    ${workOrderCount}`);
  console.log(`🔍 Inspections:    ${inspectionCount} plans, ${taskCount} tasks`);
}

// ============================================================
// Run if called directly
// ============================================================
if (require.main === module) {
  try {
    seedData();
    db.close();
    console.log('\n👋 Database connection closed.');
  } catch (err) {
    console.error('\n❌ Error seeding data:', err.message);
    console.error(err.stack);
    db.close();
    process.exit(1);
  }
}

module.exports = { seedData };
