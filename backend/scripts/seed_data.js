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
  // Temporarily disable FK checks for clean truncate
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('DELETE FROM spare_parts_transactions');
  db.exec('DELETE FROM spare_parts');
  db.exec('DELETE FROM defect_analyses');
  db.exec('DELETE FROM notifications');
  db.exec('DELETE FROM audit_logs');
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
  db.exec("DELETE FROM users WHERE username != 'admin'");
  db.exec("DELETE FROM sqlite_sequence");
  db.exec('PRAGMA foreign_keys = ON');

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
  // 7. Create spare parts inventory
  // ============================================================
  console.log('\n📦 Creating spare parts inventory...');
  const SPARE_PARTS = [
    { name: '单晶硅光伏组件 550W', code: 'PV-MOD-550', category: 'module', spec: '182mm, 144片, 半片双玻', unit: '块', qty: 120, minQty: 20, price: 1200, supplier: '隆基绿能', location: 'A区仓库-01排', status: 'active' },
    { name: '华为 SUN2000 逆变器风扇', code: 'INV-FAN-HW', category: 'inverter', spec: '适用 SUN2000-100KTL', unit: '个', qty: 8, minQty: 5, price: 850, supplier: '华为数字能源', location: 'B区仓库-02排', status: 'active' },
    { name: 'MC4 光伏连接器', code: 'CONN-MC4', category: 'connector', spec: 'IP67, 4mm²/6mm² 通用', unit: '对', qty: 500, minQty: 100, price: 12, supplier: '史陶比尔', location: 'A区仓库-03排', status: 'active' },
    { name: 'PV1-F 4mm² 光伏电缆', code: 'CABLE-PV4', category: 'cable', spec: 'DC 1500V, 阻燃, 耐紫外线', unit: '米', qty: 2000, minQty: 500, price: 3.5, supplier: '远东电缆', location: 'C区仓库', status: 'active' },
    { name: '辐照度传感器', code: 'SEN-IRR-01', category: 'sensor', spec: '0-2000 W/m², 4-20mA输出', unit: '个', qty: 3, minQty: 2, price: 2800, supplier: '华创仪表', location: 'B区仓库-01排', status: 'active' },
    { name: '温度传感器 PT100', code: 'SEN-TEMP-PT', category: 'sensor', spec: '-50~200°C, 三线制', unit: '个', qty: 6, minQty: 3, price: 180, supplier: '华创仪表', location: 'B区仓库-01排', status: 'active' },
    { name: '组串式逆变器保险丝', code: 'INV-FUSE-32A', category: 'inverter', spec: '32A DC, gPV 1500V', unit: '个', qty: 0, minQty: 10, price: 45, supplier: '施耐德电气', location: 'B区仓库-02排', status: 'out_of_stock' },
    { name: '汇流箱防雷模块', code: 'SPD-BOX-01', category: 'other', spec: 'DC 1000V, 40kA', unit: '个', qty: 4, minQty: 2, price: 680, supplier: '正泰电器', location: 'A区仓库-02排', status: 'active' },
  ];
  const stmtInsertPart = db.prepare(`
    INSERT INTO spare_parts (part_name, part_code, category, specification, unit, quantity, min_quantity, unit_price, supplier, station_id, location, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);
  const stmtInsertTrans = db.prepare(`
    INSERT INTO spare_parts_transactions (part_id, transaction_type, quantity, reference_type, performed_by, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const p of SPARE_PARTS) {
    const r = stmtInsertPart.run(p.name, p.code, p.category, p.spec, p.unit, p.qty, p.minQty, p.price, p.supplier, p.location, p.status);
    // Add transaction history
    if (p.qty > 0) {
      stmtInsertTrans.run(r.lastInsertRowid, 'in', p.qty, 'purchase', '库管员', '初始入库');
    }
    if (p.status === 'out_of_stock') {
      stmtInsertTrans.run(r.lastInsertRowid, 'out', 5, 'workorder', '张工', 'WO-003 逆变器维修领用');
    }
    console.log(`   ✅ ${p.name} (${p.code}) — 库存: ${p.qty} ${p.unit}`);
  }
  console.log(`   Total spare parts: ${SPARE_PARTS.length}`);

  // ============================================================
  // 8. Create notifications
  // ============================================================
  console.log('\n🔔 Creating notifications...');
  const NOTIFICATIONS = [
    { title: '系统升级通知', message: '光伏运维平台已完成 v2.0 升级，新增健康评分、备品备件管理模块。', type: 'system', severity: 'info', user_id: null },
    { title: '严重告警：逆变器离线', message: '海宁电站 INV-02 通讯中断超过30分钟，请立即检查。', type: 'alert', severity: 'critical', user_id: null },
    { title: '工单已分配', message: '您有新的工单「组串#3功率异常检查」，请及时处理。', type: 'workorder', severity: 'warning', user_id: null },
    { title: '巡检任务提醒', message: '「日常巡检 - 海宁电站」将于明天到期，请安排执行。', type: 'inspection', severity: 'info', user_id: null },
    { title: '备件库存预警', message: '组串式逆变器保险丝 (INV-FUSE-32A) 库存为0，请及时采购。', type: 'system', severity: 'warning', user_id: null },
    { title: '月度发电报告', message: '3月发电报告已生成，总发电量 185,230 kWh，环比增长 5.2%。', type: 'info', severity: 'info', user_id: null },
  ];
  const stmtInsertNotif = db.prepare(`
    INSERT INTO notifications (user_id, title, message, type, severity, is_read)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const n of NOTIFICATIONS) {
    stmtInsertNotif.run(n.user_id, n.title, n.message, n.type, n.severity, n.type === 'system' ? 1 : 0);
    console.log(`   🔔 ${n.title} [${n.severity}]`);
  }
  console.log(`   Total notifications: ${NOTIFICATIONS.length}`);

  // ============================================================
  // 9. Create defect analysis records
  // ============================================================
  console.log('\n🖼️ Creating defect analysis records...');
  const DEFECT_ANALYSES = [
    { station_idx: 0, label: '海宁-A区-组串03', defects: '[{"type":"热斑","severity":"high","position":"组件#47行#3列","confidence":0.92},{"type":"遮挡","severity":"medium","position":"组件#52行#1列","confidence":0.78}]', health: 'degraded', recommendation: '建议安排现场检查热斑组件，可能存在电池片损坏。遮挡物为树枝，需清理。' },
    { station_idx: 1, label: '昆山-B区-组串01', defects: '[{"type":"隐裂","severity":"critical","position":"组件#12行#5列","confidence":0.88}]', health: 'critical', recommendation: '检测到严重隐裂，建议立即更换该组件，避免热斑进一步扩大。' },
    { station_idx: 2, label: '合肥-A区-组串05', defects: '[{"type":"污秽","severity":"low","position":"大面积","confidence":0.95}]', health: 'degraded', recommendation: '组件表面积灰严重，建议安排清洗作业，预计可提升发电效率8-12%。' },
  ];
  const stmtInsertDefect = db.prepare(`
    INSERT INTO defect_analyses (station_id, image_label, image_path, defects, overall_health, recommendation, model_used, analyzed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of DEFECT_ANALYSES) {
    stmtInsertDefect.run(
      stationIds[d.station_idx],
      d.label,
      `/uploads/defect_sample_${d.station_idx}.jpg`,
      d.defects,
      d.health,
      d.recommendation,
      'qwen-vl-max',
      'admin'
    );
    console.log(`   🖼️ ${d.label} — ${d.health} (${d.defects.length > 20 ? 'AI detected' : 'manual'})`);
  }
  console.log(`   Total defect analyses: ${DEFECT_ANALYSES.length}`);

  // ============================================================
  // 10. Generate alerts based on abnormal strings
  // ============================================================
  console.log('\n🚨 Generating alerts from abnormal strings...');
  const stmtInsertAlert = db.prepare(`
    INSERT INTO alerts (station_id, type, severity, message, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let alertCount = 0;
  // Create alerts matching the abnormal strings
  const alertStatuses = ['active', 'active', 'acknowledged', 'resolved', 'active', 'acknowledged', 'resolved', 'active', 'active', 'acknowledged'];
  const alertSeverities = ['critical', 'warning', 'warning', 'critical', 'warning', 'info', 'critical', 'warning', 'warning', 'info'];
  const alertTypes = ['string_low_power', 'string_zero_output', 'temperature_high', 'inverter_offline', 'string_mismatch', 'irradiance_low', 'power_drop_sudden', 'voltage_abnormal', 'string_low_power', 'irradiance_low'];

  for (let i = 0; i < 10; i++) {
    const stationIdx = i % STATIONS.length;
    const alertTime = new Date(now);
    alertTime.setHours(8 + Math.floor(i * 1.2), Math.floor(Math.random() * 60), 0, 0);

    const messages = [
      `组串 INV-01-STR-03 功率偏低约25%，可能存在遮挡或组件故障`,
      `组串 INV-02-STR-02 检测到零输出（白天），请检查接线`,
      `环境温度达到42°C，超过安全阈值，注意设备散热`,
      `逆变器 INV-02 通讯中断超过30分钟`,
      `组串间功率差异达35%，超过正常范围`,
      `辐照度低于50 W/m²，可能为阴雨天气`,
      `组串 INV-01-STR-05 功率突降50%`,
      `组串电压异常，偏离额定值15%`,
      `组串 INV-03-STR-01 功率持续偏低`,
      `辐照度低于100 W/m²，发电效率受限`,
    ];

    stmtInsertAlert.run(
      stationIds[stationIdx],
      alertTypes[i],
      alertSeverities[i],
      messages[i],
      alertStatuses[i],
      alertTime.toISOString()
    );
    alertCount++;
  }
  console.log(`   Total alerts: ${alertCount}`);

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
  const sparePartsCount = db.prepare('SELECT COUNT(*) as count FROM spare_parts').get().count;
  const notificationsCount = db.prepare('SELECT COUNT(*) as count FROM notifications').get().count;
  const defectCount = db.prepare('SELECT COUNT(*) as count FROM defect_analyses').get().count;
  const alertsCount = db.prepare('SELECT COUNT(*) as count FROM alerts').get().count;

  console.log(`📊 Stations:        ${stationCount}`);
  console.log(`🔌 Inverters:      ${inverterCount}`);
  console.log(`🔗 Strings:        ${stringCount}`);
  console.log(`⚡ Power data:     ${powerCount.toLocaleString()} records`);
  console.log(`🌤️ Weather data:   ${weatherCount.toLocaleString()} records`);
  console.log(`⚙️ Alert rules:    ${alertRuleCount}`);
  console.log(`📋 Work orders:    ${workOrderCount}`);
  console.log(`🔍 Inspections:    ${inspectionCount} plans, ${taskCount} tasks`);
  console.log(`📦 Spare parts:    ${sparePartsCount}`);
  console.log(`🔔 Notifications:  ${notificationsCount}`);
  console.log(`🖼️ Defect analyses: ${defectCount}`);
  console.log(`🚨 Alerts:         ${alertsCount}`);
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
