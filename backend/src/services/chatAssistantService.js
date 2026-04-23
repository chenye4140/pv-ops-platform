/**
 * Chat Assistant Service — M10 运维对话助手
 *
 * Provides session-based conversational AI for the PV operations platform.
 * Supports natural-language station queries, maintenance Q&A, data analysis,
 * and multi-turn dialogue with context awareness.
 *
 * Features:
 *   - Session management (in-memory Map, production-ready for DB migration)
 *   - Intent recognition (keyword matching + LLM fallback)
 *   - Context-aware dialogue (station data injected per intent)
 *   - Multi-turn conversation history
 *   - Graceful LLM fallback to mock responses
 */

const crypto = require('crypto');
const llmService = require('./llmService');
const stationService = require('./stationService');
const powerDataService = require('./powerDataService');
const alertService = require('./alertService');
const workorderService = require('./workorderService');
const weatherService = require('./weatherService');
const inverterService = require('./inverterService');

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Session
 * @property {string} sessionId
 * @property {number|null} stationId
 * @property {string} userRole
 * @property {Date} createdAt
 * @property {Array<{role: string, content: string, timestamp: Date}>} history
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

// ---------------------------------------------------------------------------
// Intent recognition
// ---------------------------------------------------------------------------

/** @typedef {'status'|'power'|'alerts'|'workorders'|'weather'|'knowledge'|'analysis'|'chitchat'|'unknown'} Intent */

/**
 * Keyword-based intent classification.
 * Returns the most likely intent or 'unknown'.
 *
 * @param {string} message - User message text
 * @returns {Intent}
 */
function classifyIntent(message) {
  const text = message.toLowerCase();

  // Status / overview intent
  const statusKeywords = [
    '电站状态', '电站概览', '运行情况', '运行状态', '电站概况',
    '总体情况', '总览', 'overview', 'status', '发电情况',
    '发电量', '发电功率', '今日发电', '今天发电', '实时功率',
    'current power', 'today energy',
  ];
  if (statusKeywords.some((kw) => text.includes(kw))) return 'status';

  // Power data intent
  const powerKeywords = [
    '功率数据', '功率曲线', '功率趋势', '发电曲线', '发电趋势',
    '功率分析', 'string', '组串', '功率', 'voltage', 'voltage',
    '电流', 'current', 'voltage', '电压',
  ];
  if (powerKeywords.some((kw) => text.includes(kw))) return 'power';

  // Alerts intent
  const alertKeywords = [
    '告警', '报警', '警报', '故障', 'alert', 'alarm', 'error',
    '异常', '警告', 'fault',
  ];
  if (alertKeywords.some((kw) => text.includes(kw))) return 'alerts';

  // Work orders intent
  const woKeywords = [
    '工单', '维修单', '维护单', 'work order', '工单列表',
    '待处理工单', '工单状态', 'workorder', '工单查询',
  ];
  if (woKeywords.some((kw) => text.includes(kw))) return 'workorders';

  // Weather intent
  const weatherKeywords = [
    '天气', '气象', '辐照', 'irradiance', 'temperature',
    '温度', '风速', 'wind', 'weather', '日照',
  ];
  if (weatherKeywords.some((kw) => text.includes(kw))) return 'weather';

  // Analysis intent
  const analysisKeywords = [
    '分析', '对比', '比较', '趋势', '优化', '建议',
    '效率', 'performance', 'analysis', '评估', '评价',
    '怎么样', '如何', '原因', '为什么',
  ];
  if (analysisKeywords.some((kw) => text.includes(kw))) return 'analysis';

  // Knowledge intent (Q&A about PV technology / maintenance)
  const knowledgeKeywords = [
    '什么是', '怎么做', '如何', '原理', '技术', '规范',
    '标准', '手册', '知识', '培训', '光伏', '逆变器',
    '组件', '维护', '保养', 'cleaning', '清洗',
  ];
  if (knowledgeKeywords.some((kw) => text.includes(kw))) return 'knowledge';

  // Chitchat intent
  const chitchatKeywords = [
    '你好', 'hello', 'hi', 'hey', '谢谢', 'thanks',
    '感谢', '再见', 'bye', '在吗', '你是谁', '叫什么',
  ];
  if (chitchatKeywords.some((kw) => text.includes(kw))) return 'chitchat';

  return 'unknown';
}

/**
 * LLM-assisted intent recognition for ambiguous messages.
 * Falls back to keyword result if LLM is unavailable.
 *
 * @param {string} message - User message
 * @param {Intent} keywordIntent - Pre-classified keyword intent
 * @returns {Promise<Intent>}
 */
async function llmAssistedIntent(message, keywordIntent) {
  // If keyword classifier is confident enough, skip LLM
  if (keywordIntent !== 'unknown' && keywordIntent !== 'knowledge') {
    return keywordIntent;
  }

  if (!llmService.isConfigured()) {
    return keywordIntent || 'chitchat';
  }

  try {
    const systemPrompt =
      '你是一个意图分类器。请判断用户消息的意图类别，仅返回以下类别之一：' +
      'status(电站状态查询), power(功率数据查询), alerts(告警查询), ' +
      'workorders(工单查询), weather(气象数据查询), analysis(数据分析/建议), ' +
      'knowledge(运维知识问答), chitchat(闲聊)。' +
      '只返回类别名称，不要返回其他内容。';

    const result = await llmService.chat({
      prompt: `用户消息：${message}`,
      systemPrompt,
      maxTokens: 32,
      temperature: 0.1,
    });

    const intent = result.text.trim().toLowerCase();
    const validIntents = [
      'status', 'power', 'alerts', 'workorders', 'weather',
      'analysis', 'knowledge', 'chitchat',
    ];

    return validIntents.includes(intent) ? intent : (keywordIntent || 'unknown');
  } catch (error) {
    console.error('[ChatAssistant] LLM intent recognition failed, using keyword fallback:', error.message);
    return keywordIntent || 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Context data builders
// ---------------------------------------------------------------------------

/**
 * Build a human-readable context summary based on intent.
 *
 * @param {number} stationId
 * @param {Intent} intent
 * @returns {Promise<string>} Context text to inject into the prompt
 */
async function buildContextSummary(stationId, intent) {
  switch (intent) {
    case 'status':
      return _buildStatusContext(stationId);
    case 'power':
      return _buildPowerContext(stationId);
    case 'alerts':
      return _buildAlertsContext(stationId);
    case 'workorders':
      return _buildWorkOrdersContext(stationId);
    case 'weather':
      return _buildWeatherContext(stationId);
    case 'analysis':
      // For analysis, combine status + alerts for richer context
      const [statusCtx, alertsCtx] = await Promise.all([
        _buildStatusContext(stationId),
        _buildAlertsContext(stationId),
      ]);
      return statusCtx + '\n\n---\n\n' + alertsCtx;
    default:
      return '';
  }
}

/**
 * @param {number} stationId
 * @returns {string}
 */
function _buildStatusContext(stationId) {
  const overview = stationService.getOverview(stationId);
  if (!overview) {
    return '未找到电站信息。';
  }

  const s = overview.station;
  const lines = [
    `【电站信息】名称: ${s.name} | 装机容量: ${s.capacity_mw} MW | 位置: ${s.location} | 状态: ${s.status}`,
    `【今日发电】${overview.todayEnergyKwh} kWh`,
    `【当前功率】${overview.currentPowerKw} kW`,
    `【异常组串】${overview.abnormalCount} 个`,
    `【活跃告警】${overview.activeAlerts} 条`,
    `【性能比 PR】${overview.performanceRatio}%`,
    `【逆变器】${overview.inverterCount} 台 | 【组串】${overview.stringCount} 路`,
  ];

  return lines.join('\n');
}

/**
 * @param {number} stationId
 * @returns {string}
 */
function _buildPowerContext(stationId) {
  const overview = stationService.getOverview(stationId);
  if (!overview) return '未找到电站信息。';

  const lines = [
    `【电站】${overview.station.name}`,
    `【当前功率】${overview.currentPowerKw} kW`,
    `【今日发电】${overview.todayEnergyKwh} kWh`,
  ];

  // Add inverter-level summary
  const inverters = inverterService.getByStationId(stationId);
  if (inverters && inverters.length > 0) {
    lines.push(`\n【逆变器列表】(${inverters.length} 台):`);
    const topInverters = inverters.slice(0, 5);
    for (const inv of topInverters) {
      lines.push(
        `  - ${inv.name} (${inv.model}): 状态=${inv.status}, ` +
        `组串=${inv.string_count}, 异常=${inv.abnormal_string_count}`
      );
    }
    if (inverters.length > 5) {
      lines.push(`  ... 还有 ${inverters.length - 5} 台逆变器`);
    }
  }

  return lines.join('\n');
}

/**
 * @param {number} stationId
 * @returns {string}
 */
function _buildAlertsContext(stationId) {
  const alerts = alertService.getAll(stationId, 'active');
  const station = stationService.getById(stationId);
  const stationName = station ? station.name : `ID=${stationId}`;

  if (!alerts || alerts.length === 0) {
    return `【${stationName}】当前无活跃告警。`;
  }

  const lines = [`【${stationName}】活跃告警 (${alerts.length} 条):`];
  const topAlerts = alerts.slice(0, 10);
  for (const a of topAlerts) {
    lines.push(
      `  - [${a.severity?.toUpperCase() || 'WARNING'}] ${a.type}: ${a.message} ` +
      `(创建于: ${a.created_at})`
    );
  }
  if (alerts.length > 10) {
    lines.push(`  ... 还有 ${alerts.length - 10} 条告警`);
  }

  return lines.join('\n');
}

/**
 * @param {number} stationId
 * @returns {string}
 */
function _buildWorkOrdersContext(stationId) {
  const wos = workorderService.getAll({ station_id: stationId });
  const station = stationService.getById(stationId);
  const stationName = station ? station.name : `ID=${stationId}`;

  if (!wos || wos.length === 0) {
    return `【${stationName}】当前无工单。`;
  }

  // Group by status
  const byStatus = {};
  for (const wo of wos) {
    byStatus[wo.status] = (byStatus[wo.status] || 0) + 1;
  }

  const lines = [`【${stationName}】工单统计 (共 ${wos.length} 条):`];
  for (const [status, count] of Object.entries(byStatus)) {
    lines.push(`  - ${status}: ${count} 条`);
  }

  // Show recent pending/in_progress
  const activeWos = wos
    .filter((wo) => ['pending', 'assigned', 'in_progress'].includes(wo.status))
    .slice(0, 5);

  if (activeWos.length > 0) {
    lines.push('\n【活跃工单】:');
    for (const wo of activeWos) {
      lines.push(
        `  - [${wo.priority?.toUpperCase() || 'MEDIUM'}] ${wo.title} ` +
        `(类型: ${wo.type}, 状态: ${wo.status})`
      );
    }
  }

  return lines.join('\n');
}

/**
 * @param {number} stationId
 * @returns {string}
 */
function _buildWeatherContext(stationId) {
  const latest = weatherService.getLatest(stationId);
  const station = stationService.getById(stationId);
  const stationName = station ? station.name : `ID=${stationId}`;

  if (!latest) {
    return `【${stationName}】暂无气象数据。`;
  }

  const lines = [
    `【${stationName}】最新气象数据:`,
    `  - 时间: ${latest.timestamp}`,
    `  - 辐照度: ${latest.irradiance_wm2} W/m²`,
    `  - 温度: ${latest.temperature_c} °C`,
    `  - 风速: ${latest.wind_speed_ms} m/s`,
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Create a new chat session.
 *
 * @param {number} stationId - Associated station ID
 * @param {string} [userId] - Optional user identifier
 * @param {string} [userRole] - User role (default: '运维工程师')
 * @returns {Promise<{sessionId: string, stationId: number|null}>}
 */
async function createSession(stationId, userId, userRole = '运维工程师') {
  const sessionId = crypto.randomUUID();

  /** @type {Session} */
  const session = {
    sessionId,
    stationId: stationId || null,
    userRole,
    createdAt: new Date(),
    history: [],
  };

  sessions.set(sessionId, session);
  console.log(`[ChatAssistant] Session created: ${sessionId} (station=${stationId}, user=${userId || 'anonymous'})`);

  return { sessionId, stationId: session.stationId };
}

/**
 * Send a message to the chat assistant and get an AI reply.
 *
 * @param {string} sessionId - Active session ID
 * @param {string} userMessage - User's message text
 * @param {object} [options]
 * @param {number} [options.stationId] - Override session stationId
 * @param {number} [options.maxHistory] - Max history messages to send to LLM (default: 10)
 * @returns {Promise<{reply: string, intent: Intent, contextUsed: boolean}>}
 */
async function sendMessage(sessionId, userMessage, options = {}) {
  // 1. Load session
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const stationId = options.stationId || session.stationId;

  // 2. Save user message to history
  session.history.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date(),
  });

  // 3. Intent recognition
  const keywordIntent = classifyIntent(userMessage);
  const intent = await llmAssistedIntent(userMessage, keywordIntent);

  // 4. Build context data
  let contextSummary = '';
  let contextUsed = false;
  if (stationId) {
    contextSummary = await buildContextSummary(stationId, intent);
    contextUsed = contextSummary.length > 0;
  }

  // 5. Format chat history for LLM
  const maxHistory = options.maxHistory || 10;
  const recentHistory = session.history.slice(-(maxHistory * 2)); // pairs of user+assistant
  const formattedHistory = recentHistory
    .filter((msg) => msg.role === 'assistant' || msg.role === 'user')
    .map((msg) => `${msg.role === 'user' ? '用户' : '助手'}: ${msg.content}`);

  const chatHistoryText = formattedHistory.length > 0
    ? formattedHistory.join('\n')
    : '（无历史对话）';

  // 6. Build station display name
  let stationName = '未指定';
  if (stationId) {
    const station = stationService.getById(stationId);
    stationName = station ? station.name : `ID=${stationId}`;
  }

  // 7. Load and render prompt template
  const systemPrompt = llmService.loadPrompt('chat-assistant.md', {
    userRole: session.userRole,
    currentStation: stationName,
    chatHistory: chatHistoryText,
    userQuestion: userMessage,
  });

  // 8. Append context summary if available
  let fullSystemPrompt = systemPrompt;
  if (contextUsed && contextSummary) {
    fullSystemPrompt += `\n\n## 电站实时数据\n\n${contextSummary}\n\n请基于以上实时数据回答用户的问题。如果用户的问题与数据相关，请引用具体数值进行分析。`;
  }

  // 9. Call LLM
  let replyText = '';
  try {
    const result = await llmService.chat({
      prompt: userMessage,
      systemPrompt: fullSystemPrompt,
      messages: _buildLLMMessages(fullSystemPrompt, recentHistory),
      maxTokens: 2048,
      temperature: 0.4,
    });
    replyText = result.text;
  } catch (error) {
    console.error('[ChatAssistant] LLM chat failed:', error.message);
    replyText = `抱歉，AI 服务暂时不可用。错误信息：${error.message}`;
  }

  // 10. Save assistant reply to history
  session.history.push({
    role: 'assistant',
    content: replyText,
    timestamp: new Date(),
  });

  // 11. Trim history to prevent unbounded growth (keep last 40 messages)
  if (session.history.length > 40) {
    session.history = session.history.slice(-40);
  }

  return {
    reply: replyText,
    intent,
    contextUsed,
  };
}

/**
 * Build a proper OpenAI-format message array for the LLM.
 *
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} history
 * @returns {Array<{role: string, content: string}>}
 */
function _buildLLMMessages(systemPrompt, history) {
  const messages = [{ role: 'system', content: systemPrompt }];

  for (const msg of history) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      messages.push({ role: 'assistant', content: msg.content });
    }
  }

  return messages;
}

/**
 * Get chat history for a session.
 *
 * @param {string} sessionId
 * @param {number} [limit] - Max messages to return (default: 20)
 * @returns {Promise<Array<{role: string, content: string, timestamp: Date}>>}
 */
async function getChatHistory(sessionId, limit = 20) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const history = session.history.slice(-limit);
  return history.map((msg) => ({
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
  }));
}

/**
 * Delete a session and free its memory.
 *
 * @param {string} sessionId
 * @returns {Promise<{deleted: boolean, sessionId: string}>}
 */
async function deleteSession(sessionId) {
  const exists = sessions.has(sessionId);
  sessions.delete(sessionId);

  console.log(`[ChatAssistant] Session deleted: ${sessionId}`);
  return { deleted: exists, sessionId };
}

/**
 * Get context data for a station based on intent.
 * Returns structured data that can be used by other services or the UI.
 *
 * @param {number} stationId
 * @param {Intent} intent
 * @returns {Promise<object>} Structured context data
 */
async function getContextData(stationId, intent) {
  switch (intent) {
    case 'status': {
      const overview = stationService.getOverview(stationId);
      return { type: 'status', data: overview };
    }
    case 'power': {
      const overview = stationService.getOverview(stationId);
      const inverters = inverterService.getByStationId(stationId);
      return {
        type: 'power',
        data: {
          currentPower: overview?.currentPowerKw || 0,
          todayEnergy: overview?.todayEnergyKwh || 0,
          inverters,
        },
      };
    }
    case 'alerts': {
      const alerts = alertService.getAll(stationId, 'active');
      return { type: 'alerts', data: alerts };
    }
    case 'workorders': {
      const workorders = workorderService.getAll({ station_id: stationId });
      return { type: 'workorders', data: workorders };
    }
    case 'weather': {
      const latest = weatherService.getLatest(stationId);
      return { type: 'weather', data: latest };
    }
    default:
      return { type: intent, data: null };
  }
}

/**
 * Get session info (without full history).
 *
 * @param {string} sessionId
 * @returns {Promise<{sessionId: string, stationId: number|null, userRole: string, createdAt: Date, messageCount: number}|null>}
 */
async function getSessionInfo(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  return {
    sessionId: session.sessionId,
    stationId: session.stationId,
    userRole: session.userRole,
    createdAt: session.createdAt,
    messageCount: session.history.length,
  };
}

/**
 * Get total active session count (useful for monitoring).
 *
 * @returns {number}
 */
function getActiveSessionCount() {
  return sessions.size;
}

/**
 * Clear all sessions (useful for testing or graceful shutdown).
 *
 * @returns {number} Number of sessions cleared
 */
function clearAllSessions() {
  const count = sessions.size;
  sessions.clear();
  console.log(`[ChatAssistant] All sessions cleared (${count} sessions)`);
  return count;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Session management
  createSession,
  sendMessage,
  getChatHistory,
  deleteSession,
  getSessionInfo,

  // Context data
  getContextData,

  // Intent recognition (exposed for testing)
  classifyIntent,
  llmAssistedIntent,

  // Monitoring / maintenance
  getActiveSessionCount,
  clearAllSessions,
};
