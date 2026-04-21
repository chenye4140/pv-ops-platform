# 光伏运维AI智能分析平台 - MVP 规划

## 项目概述
光伏运维AI智能分析平台（pv-ops-platform），为光伏电站运维人员提供实时监控、数据分析和AI辅助决策能力。

## 技术栈
- **后端**: Node.js + Express + SQLite (better-sqlite3)
- **前端**: 单HTML文件 + ECharts 可视化
- **AI分析**: 接口预留（对接视觉大模型进行缺陷图像分析）

## MVP 核心功能

### 1. 数据模拟层 ✅
- 1个电站（西北光伏电站A，10MW）
- 10台逆变器（4种型号混用）
- 80个组串（每台逆变器8个组串）
- 7天数据，15分钟粒度（共672个时间点）
- 4个异常组串（功率偏低20-30%）
- 模拟气象数据（辐照度、温度、风速）
- 模拟告警数据

### 2. 后端API
| 接口 | 方法 | 描述 |
|------|------|------|
| `/api/stations` | GET | 获取所有电站列表 |
| `/api/stations/:id` | GET | 获取电站详情 |
| `/api/stations/:id/overview` | GET | 电站总览数据（今日发电、当前功率、PR等） |
| `/api/stations/:id/inverters` | GET | 获取电站下所有逆变器 |
| `/api/stations/:id/inverters/:invId/strings` | GET | 获取逆变器下所有组串 |
| `/api/power-data` | GET | 获取功率时序数据（按组串+时间范围） |
| `/api/weather` | GET | 获取气象数据 |
| `/api/alerts` | GET | 获取告警列表（支持按状态过滤） |
| `/api/analysis/defect-image` | POST | AI图像分析（MVP返回模拟结果） |
| `/api/reports/daily` | GET | 生成日报预览 |

### 3. 前端页面
- **Dashboard**: 单HTML页面，包含：
  - 电站总览卡片（今日发电量、当前功率、PR、异常数）
  - 发电曲线图（ECharts折线图，支持多日对比）
  - 逆变器状态列表（表格展示运行状态、组串数、异常数）
  - 异常告警面板（按严重程度着色）
- **图像分析页面**: 上传/展示模拟缺陷图片，显示AI分析结果
- **日报页面**: 展示当日运维日报预览

## 验收标准
- [ ] 后端正常启动，API全部可用
- [ ] 模拟电站数据完整（1电站、10逆变器、80组串、7天数据）
- [ ] 前端Dashboard可正常展示所有面板
- [ ] 图像分析页面可用
- [ ] 日报预览可用
- [ ] 前后端联调通过

## 项目结构
```
pv-ops-platform/
├── MVP_PLANNING.md
├── backend/
│   ├── package.json
│   ├── server.js                  # Express入口
│   ├── src/
│   │   ├── models/
│   │   │   └── database.js        # SQLite数据库
│   │   ├── services/
│   │   │   ├── stationService.js  # 电站服务
│   │   │   ├── inverterService.js # 逆变器服务
│   │   │   ├── powerDataService.js# 功率数据服务
│   │   │   ├── alertService.js    # 告警服务 (新增)
│   │   │   └── weatherService.js  # 气象服务 (新增)
│   │   ├── routes/
│   │   │   ├── stationRoutes.js   # 电站路由
│   │   │   ├── powerRoutes.js     # 功率数据路由
│   │   │   ├── alertRoutes.js     # 告警路由
│   │   │   ├── weatherRoutes.js   # 气象路由
│   │   │   ├── analysisRoutes.js  # AI分析路由
│   │   │   └── reportRoutes.js    # 日报路由
│   │   └── utils/
│   │       └── generate_mock_data.js
├── frontend/
│   ├── index.html                 # 主Dashboard
│   ├── analysis.html              # 图像分析页面
│   └── daily-report.html          # 日报页面
└── data/                          # SQLite数据库文件
    └── pv_ops.db
```
