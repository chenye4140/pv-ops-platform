/**
 * Workorder Intelligence Service — AI-powered work order processing
 *
 * Provides intelligent work order classification, assignee recommendation,
 * solution recommendation, completion report generation, and trend analysis
 * using LLM (via llmService) with graceful fallback strategies.
 *
 * This is the M8 module of the PV O&M platform.
 */
const { db } = require('../models/database');
const llmService = require('./llmService');
const workorderService = require('./workorderService');
const alertAnalysisService = require('./alertAnalysisService');
const sparePartsService = require('./sparePartsService');

// ---------------------------------------------------------------------------
// LLM schemas for structured output
// ---------------------------------------------------------------------------

/** Schema for work order classification */
const CLASSIFY_SCHEMA = {
  type: 'object',
  required: ['suggestedType', 'confidence', 'reasoning', 'needCorrection'],
  properties: {
    suggestedType: { type: 'string' },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
    needCorrection: { type: 'boolean' },
  },
};

/** Schema for assignee recommendation */
const ASSIGNEE_SCHEMA = {
  type: 'object',
  required: ['recommendedPerson', 'reason', 'availableParts', 'estimatedTime'],
  properties: {
    recommendedPerson: { type: 'string' },
    reason: { type: 'string' },
    availableParts: { type: 'array', items: { type: 'object', properties: { part_name: { type: 'string' }, quantity: { type: 'number' } } } },
    estimatedTime: { type: 'string' },
    requiredSkills: { type: 'array', items: { type: 'string' } },
    alternativePerson: { type: 'string' },
  },
};

/** Schema for solution recommendation */
const SOLUTION_SCHEMA = {
  type: 'object',
  required: ['steps', 'requiredParts', 'estimatedDuration', 'precautions', 'similarCases'],
  properties: {
    steps: { type: 'array', items: { type: 'object', properties: { step: { type: 'number' }, action: { type: 'string' }, notes: { type: 'string' } } } },
    requiredParts: { type: 'array', items: { type: 'object', properties: { part_name: { type: 'string' }, quantity: { type: 'number' }, category: { type: 'string' } } } },
    estimatedDuration: { type: 'string' },
    precautions: { type: 'array', items: { type: 'string' } },
    similarCases: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, title: { type: 'string' }, outcome: { type: 'string' } } } },
    rootCause: { type: 'string' },
    tools: { type: 'array', items: { type: 'string' } },
  },
};

/** Schema for completion report */
const COMPLETION_REPORT_SCHEMA = {
  type: 'object',
  required: ['summary', 'actionsTaken', 'partsUsed', 'recommendations', 'followUpNeeded'],
  properties: {
    summary: { type: 'string' },
    actionsTaken: { type: 'array', items: { type: 'string' } },
    partsUsed: { type: 'array', items: { type: 'object', properties: { part_name: { type: 'string' }, quantity: { type: 'number' } } } },
    recommendations: { type: 'array', items: { type: 'string' } },
    followUpNeeded: { type: 'boolean' },
    followUpActions: { type: 'array', items: { type: 'string' } },
    lessonsLearned: { type: 'string' },
  },
};

/** Schema for trend analysis */
const TREND_SCHEMA = {
  type: 'object',
  required: ['statistics', 'patterns', 'recommendations'],
  properties: {
    statistics: {
      type: 'object',
      properties: {
        totalWorkOrders: { type: 'number' },
        byType: { type: 'array', items: { type: 'object' } },
        byPriority: { type: 'array', items: { type: 'object' } },
        byStatus: { type: 'array', items: { type: 'object' } },
        avgResolutionHours: { type: 'number' },
        completionRate: { type: 'number' },
      },
    },
    patterns: { type: 'array', items: { type: 'object', properties: { pattern: { type: 'string' }, description: { type: 'string' }, impact: { type: 'string' } } } },
    recommendations: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

// ---------------------------------------------------------------------------
// Internal helpers — data gathering
// ---------------------------------------------------------------------------

/**
 * Get station info by ID.
 *
 * @param {number} stationId
 * @returns {{ name: string, location: string }|null}
 */
function _getStationInfo(stationId) {
  return db.prepare(
    'SELECT id, name, location FROM stations WHERE id = ?'
  ).get(stationId);
}

/**
 * Get available users who can be assigned, with workload info.
 *
 * @param {number} [stationId] - Optional station filter
 * @returns {Array<{ id: number, username: string, role: string, station_ids: string, activeWorkOrders: number }>}
 */
function _getAvailableUsers(stationId) {
  let sql = `
    SELECT u.id, u.username, u.role, u.station_ids, u.is_active,
      (SELECT COUNT(*) FROM work_orders wo
       WHERE wo.assignee = u.username
         AND wo.status IN ('assigned', 'in_progress')) as activeWorkOrders
    FROM users u
    WHERE u.is_active = 1
      AND u.role IN ('technician', 'engineer', 'manager')
  `;
  const params = [];

  if (stationId) {
    sql += ' AND (u.station_ids LIKE ? OR u.station_ids IS NULL OR u.station_ids = \'\')';
    params.push(`%"${stationId}"%`);
  }

  sql += ' ORDER BY activeWorkOrders ASC';

  return db.prepare(sql).all(...params);
}

/**
 * Get spare parts relevant to a work order's station.
 *
 * @param {number|null} stationId
 * @returns {Array<object>}
 */
function _getSpareParts(stationId) {
  const filters = {};
  if (stationId) filters.station_id = stationId;
  return sparePartsService.getAll(filters);
}

/**
 * Get low-stock spare parts warning.
 *
 * @returns {Array<object>}
 */
function _getLowStockParts() {
  return sparePartsService.getAll({ low_stock: true });
}

/**
 * Find similar work orders by type and station.
 *
 * @param {string} type
 * @param {number|null} stationId
 * @param {number} [limit=5]
 * @returns {Array<object>}
 */
function _getSimilarWorkOrders(type, stationId, limit = 5) {
  let sql = `
    SELECT wo.id, wo.title, wo.description, wo.type, wo.status,
           wo.completed_at, wo.created_at, wo.assignee,
           s.name as station_name
    FROM work_orders wo
    LEFT JOIN stations s ON wo.station_id = s.id
    WHERE wo.type = ?
      AND wo.status IN ('completed', 'closed')
  `;
  const params = [type];

  if (stationId) {
    sql += ' AND wo.station_id = ?';
    params.push(stationId);
  }

  sql += ' ORDER BY wo.created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Get root cause analysis for an alert linked to a work order.
 *
 * @param {number} alertId
 * @returns {Promise<object|null>}
 */
async function _getRootCause(alertId) {
  try {
    return await alertAnalysisService.getAlertRootCause(alertId);
  } catch (err) {
    console.error('[WorkorderIntelligenceService] Root cause analysis failed:', err.message);
    return null;
  }
}

/**
 * Format work order notes into readable text.
 *
 * @param {Array<object>} notes
 * @returns {string}
 */
function _formatNotes(notes) {
  if (!notes || notes.length === 0) return '无备注';
  return notes.map((n) =>
    `[${n.created_at}] ${n.created_by || '系统'}: ${n.content}`
  ).join('\n');
}

/**
 * Format spare parts list for LLM prompt.
 *
 * @param {Array<object>} parts
 * @returns {string}
 */
function _formatSpareParts(parts) {
  if (!parts || parts.length === 0) return '暂无备件';
  return parts.map((p) =>
    `${p.part_name} (${p.category}): 库存 ${p.quantity}, 最低 ${p.min_quantity}`
  ).join('\n');
}

/**
 * Format user list for LLM prompt.
 *
 * @param {Array<object>} users
 * @returns {string}
 */
function _formatUsers(users) {
  if (!users || users.length === 0) return '无可用人员';
  return users.map((u) =>
    `${u.username} (角色: ${u.role}, 当前工单: ${u.activeWorkOrders}件)`
  ).join('\n');
}

// ---------------------------------------------------------------------------
// Fallback functions (when LLM is unavailable)
// ---------------------------------------------------------------------------

function _buildFallbackClassification(workOrder) {
  const typeLabels = {
    defect_repair: '缺陷维修',
    routine_maintenance: '定期维护',
    inspection: '巡检',
    cleaning: '清洗',
    other: '其他',
  };
  return {
    currentType: workOrder.type,
    currentTypeLabel: typeLabels[workOrder.type] || workOrder.type,
    suggestedType: workOrder.type,
    confidence: 0.5,
    reasoning: 'LLM 分析不可用，基于规则保持原分类。建议配置 DASHSCOPE_API_KEY 启用智能分类。',
    needCorrection: false,
    model: 'rule-based-fallback',
  };
}

function _buildFallbackAssignee(workOrder, users) {
  const availableUser = users && users.length > 0
    ? users.find((u) => u.activeWorkOrders < 5) || users[0]
    : null;
  return {
    recommendedPerson: availableUser ? availableUser.username : '待分配',
    reason: availableUser
      ? `当前负载最低（${availableUser.activeWorkOrders}件工单），角色: ${availableUser.role}`
      : 'LLM 不可用，按负载最低规则推荐',
    availableParts: [],
    estimatedTime: '待评估',
    requiredSkills: [],
    alternativePerson: null,
    model: 'rule-based-fallback',
  };
}

function _buildFallbackSolution(workOrder) {
  return {
    steps: [
      { step: 1, action: '现场确认问题', notes: '到达现场后确认工单描述的问题' },
      { step: 2, action: '检查设备状态', notes: '查看相关设备运行参数' },
      { step: 3, action: '执行修复', notes: '根据检查结果进行修复' },
      { step: 4, action: '验证修复效果', notes: '确认问题已解决' },
    ],
    requiredParts: [],
    estimatedDuration: '待评估',
    precautions: ['注意安全操作规范', '做好现场记录'],
    similarCases: [],
    rootCause: '待现场确认后确定',
    tools: [],
    model: 'rule-based-fallback',
  };
}

function _buildFallbackReport(workOrder, notes) {
  return {
    summary: `工单"${workOrder.title}"已完成处理。`,
    actionsTaken: notes && notes.length > 0
      ? notes.map((n) => n.content)
      : ['已完成现场处理'],
    partsUsed: [],
    recommendations: ['建议持续监控相关设备状态'],
    followUpNeeded: false,
    followUpActions: [],
    lessonsLearned: '',
    model: 'rule-based-fallback',
  };
}

function _buildFallbackTrend(statistics) {
  return {
    statistics,
    patterns: [
      {
        pattern: '基础统计模式',
        description: `共 ${statistics.totalWorkOrders} 件工单，完成率 ${statistics.completionRate}%`,
        impact: '中等',
      },
    ],
    recommendations: [
      '建议配置 DASHSCOPE_API_KEY 启用 LLM 趋势分析',
      '定期关注高优先级工单比例',
      '检查超时未处理的工单',
    ],
    summary: `过去 ${statistics.period || 30} 天共 ${statistics.totalWorkOrders} 件工单。LLM 不可用，仅提供基础统计。`,
    model: 'rule-based-fallback',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const workorderIntelligenceService = {

  /**
   * Intelligently classify a work order.
   *
   * Queries work order details and associated alert info,
   * then uses LLM to analyze if the current type is correct.
   *
   * @param {number} workOrderId - Work order ID to classify
   * @returns {Promise<{
   *   currentType: string,
   *   currentTypeLabel: string,
   *   suggestedType: string,
   *   confidence: number,
   *   reasoning: string,
   *   needCorrection: boolean,
   *   model: string
   * }>}
   */
  async classifyWorkorder(workOrderId) {
    const wo = workorderService.getById(workOrderId);
    if (!wo) {
      throw new Error(`Work order not found: ${workOrderId}`);
    }

    const station = wo.station_id ? _getStationInfo(wo.station_id) : null;

    // Gather alert context if linked
    let alertContext = '';
    let rootCauseData = null;
    if (wo.alert_id) {
      try {
        const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(wo.alert_id);
        if (alert) {
          alertContext = `关联告警: [${alert.severity}] ${alert.type} — ${alert.message}`;
          rootCauseData = await _getRootCause(wo.alert_id);
          if (rootCauseData && rootCauseData.root_cause) {
            alertContext += `\n根因分析: ${rootCauseData.root_cause}`;
          }
        }
      } catch (err) {
        console.error('[WorkorderIntelligenceService] Failed to get alert context:', err.message);
      }
    }

    const typeLabels = {
      defect_repair: '缺陷维修',
      routine_maintenance: '定期维护',
      inspection: '巡检',
      cleaning: '清洗',
      other: '其他',
    };

    const context = {
      workOrderId: wo.id,
      workOrderTitle: wo.title,
      workOrderDescription: wo.description || '无描述',
      workOrderType: wo.type,
      workOrderTypeLabel: typeLabels[wo.type] || wo.type,
      workOrderPriority: wo.priority,
      stationName: station?.name || '未关联电站',
      alertContext: alertContext || '无关联告警',
      notes: _formatNotes(wo.notes),
    };

    let prompt;
    try {
      prompt = llmService.loadPrompt('workorder-recommend.md', context);
    } catch (err) {
      console.error('[WorkorderIntelligenceService] Failed to load prompt:', err.message);
      return _buildFallbackClassification(wo);
    }

    const classificationPrompt = `
你是光伏运维工单分类专家。请分析以下工单的类型是否正确：

- 工单ID: ${wo.id}
- 工单标题: ${wo.title}
- 工单描述: ${wo.description || '无描述'}
- 当前类型: ${typeLabels[wo.type] || wo.type} (${wo.type})
- 优先级: ${wo.priority}
- 电站: ${station?.name || '未关联电站'}
- ${alertContext || '无关联告警'}
- 处理备注: ${_formatNotes(wo.notes)}

可选的工单类型：
- defect_repair（缺陷维修）— 设备故障或缺陷需要修复
- routine_maintenance（定期维护）— 计划性维护保养
- inspection（巡检）— 设备巡检检查
- cleaning（清洗）— 组件或设备清洗
- other（其他）— 不属于以上分类

请返回 JSON 格式的分析结果，包括：
- suggestedType: 建议的正确类型（如果当前类型正确则保持一致）
- confidence: 置信度 (0-1)
- reasoning: 分析理由
- needCorrection: 是否需要修正类型
`;

    try {
      const result = await llmService.structuredOutput({
        prompt: classificationPrompt,
        systemPrompt: '你是光伏电站运维工单分类专家。请严格以 JSON 格式返回分类结果。',
        schema: CLASSIFY_SCHEMA,
        maxTokens: 1024,
        temperature: 0.1,
      });

      return {
        workOrderId: wo.id,
        currentType: wo.type,
        currentTypeLabel: typeLabels[wo.type] || wo.type,
        suggestedType: result.data?.suggestedType || wo.type,
        confidence: result.data?.confidence || 0.5,
        reasoning: result.data?.reasoning || '分析完成',
        needCorrection: result.data?.needCorrection || false,
        model: result.model,
        fallback: !result.valid,
      };
    } catch (error) {
      console.error('[WorkorderIntelligenceService] Classification failed, using fallback:', error.message);
      return _buildFallbackClassification(wo);
    }
  },

  /**
   * Recommend the best assignee for a work order.
   *
   * Considers work order type, station location, available personnel,
   * current workload, and spare parts availability.
   *
   * @param {number} workOrderId - Work order ID to recommend assignee for
   * @returns {Promise<{
   *   recommendedPerson: string,
   *   reason: string,
   *   availableParts: Array<{ part_name: string, quantity: number }>,
   *   estimatedTime: string,
   *   requiredSkills: Array<string>,
   *   alternativePerson: string|null,
   *   model: string,
   *   fallback: boolean
   * }>}
   */
  async recommendAssignee(workOrderId) {
    const wo = workorderService.getById(workOrderId);
    if (!wo) {
      throw new Error(`Work order not found: ${workOrderId}`);
    }

    const station = wo.station_id ? _getStationInfo(wo.station_id) : null;
    const users = _getAvailableUsers(wo.station_id);
    const parts = _getSpareParts(wo.station_id);
    const lowStock = _getLowStockParts();

    // Gather root cause if alert-linked
    let rootCause = '';
    if (wo.alert_id) {
      const rc = await _getRootCause(wo.alert_id);
      if (rc && rc.root_cause) {
        rootCause = `根因分析: ${rc.root_cause}`;
      }
    }

    const context = {
      workOrderTitle: wo.title,
      workOrderType: wo.type,
      workOrderPriority: wo.priority,
      stationName: station?.name || '未关联电站',
      availableWorkers: _formatUsers(users),
      sparePartsInventory: _formatSpareParts(parts),
      lowStockWarning: lowStock.length > 0
        ? `库存不足: ${lowStock.map((p) => p.part_name).join(', ')}`
        : '备件充足',
      rootCause,
    };

    let prompt;
    try {
      prompt = llmService.loadPrompt('workorder-recommend.md', context);
    } catch (err) {
      console.error('[WorkorderIntelligenceService] Failed to load prompt:', err.message);
      return _buildFallbackAssignee(wo, users);
    }

    const assigneePrompt = `
你是光伏运维派单专家。请为以下工单推荐最佳负责人：

- 工单ID: ${wo.id}
- 工单标题: ${wo.title}
- 工单描述: ${wo.description || '无描述'}
- 工单类型: ${wo.type}
- 优先级: ${wo.priority}
- 电站: ${station?.name || '未关联电站'} (${station?.location || ''})
${rootCause ? '\n- ' + rootCause : ''}

可用运维人员:
${_formatUsers(users)}

备件库存:
${_formatSpareParts(parts)}
${lowStock.length > 0 ? '\n⚠️ 库存不足预警: ' + lowStock.map((p) => `${p.part_name} (当前${p.quantity})`).join(', ') : ''}

请综合考虑人员技能匹配度、当前负载、地理位置和备件情况，推荐最佳负责人。
返回 JSON 格式：
- recommendedPerson: 推荐人员用户名
- reason: 推荐理由
- availableParts: 相关可用备件列表 [{ part_name, quantity }]
- estimatedTime: 预估处理时间
- requiredSkills: 所需技能列表
- alternativePerson: 备选人员（如有）
`;

    try {
      const result = await llmService.structuredOutput({
        prompt: assigneePrompt,
        systemPrompt: '你是光伏电站运维派单专家。请根据工单类型、人员技能和负载情况推荐最佳负责人。严格以 JSON 格式返回。',
        schema: ASSIGNEE_SCHEMA,
        maxTokens: 1024,
        temperature: 0.1,
      });

      const data = result.data || {};
      return {
        workOrderId: wo.id,
        recommendedPerson: data.recommendedPerson || '待分配',
        reason: data.reason || '基于负载最低规则推荐',
        availableParts: data.availableParts || [],
        estimatedTime: data.estimatedTime || '待评估',
        requiredSkills: data.requiredSkills || [],
        alternativePerson: data.alternativePerson || null,
        model: result.model,
        fallback: !result.valid,
      };
    } catch (error) {
      console.error('[WorkorderIntelligenceService] Assignee recommendation failed, using fallback:', error.message);
      return _buildFallbackAssignee(wo, users);
    }
  },

  /**
   * Recommend a solution for a work order.
   *
   * Analyzes work order details, alert root cause, and historical
   * similar work orders to generate a structured solution.
   *
   * @param {number} workOrderId - Work order ID
   * @returns {Promise<{
   *   steps: Array<{ step: number, action: string, notes: string }>,
   *   requiredParts: Array<{ part_name: string, quantity: number, category: string }>,
   *   estimatedDuration: string,
   *   precautions: Array<string>,
   *   similarCases: Array<{ id: number, title: string, outcome: string }>,
   *   rootCause: string,
   *   tools: Array<string>,
   *   model: string,
   *   fallback: boolean
   * }>}
   */
  async recommendSolution(workOrderId) {
    const wo = workorderService.getById(workOrderId);
    if (!wo) {
      throw new Error(`Work order not found: ${workOrderId}`);
    }

    const station = wo.station_id ? _getStationInfo(wo.station_id) : null;
    const similarCases = _getSimilarWorkOrders(wo.type, wo.station_id, 5);

    // Gather root cause analysis
    let rootCauseData = null;
    let rootCauseText = '';
    if (wo.alert_id) {
      rootCauseData = await _getRootCause(wo.alert_id);
      if (rootCauseData) {
        rootCauseText = rootCauseData.root_cause || '';
      }
    }

    const parts = _getSpareParts(wo.station_id);

    const similarCasesText = similarCases.length > 0
      ? similarCases.map((sc, i) =>
        `${i + 1}. [${sc.type}] ${sc.title} — 处理人: ${sc.assignee || '未知'}, 状态: ${sc.status}`
      ).join('\n')
      : '无历史相似工单';

    const context = {
      workOrderTitle: wo.title,
      workOrderDescription: wo.description || '无描述',
      workOrderType: wo.type,
      workOrderPriority: wo.priority,
      stationName: station?.name || '未关联电站',
      rootCause: rootCauseText || '未进行根因分析',
      similarCases: similarCasesText,
      sparePartsInventory: _formatSpareParts(parts),
    };

    let prompt;
    try {
      prompt = llmService.loadPrompt('workorder-recommend.md', context);
    } catch (err) {
      console.error('[WorkorderIntelligenceService] Failed to load prompt:', err.message);
      return _buildFallbackSolution(wo);
    }

    const solutionPrompt = `
你是光伏运维解决方案专家。请为以下工单推荐详细的解决方案：

- 工单ID: ${wo.id}
- 工单标题: ${wo.title}
- 工单描述: ${wo.description || '无描述'}
- 工单类型: ${wo.type}
- 优先级: ${wo.priority}
- 电站: ${station?.name || '未关联电站'}
${rootCauseText ? '\n- 根因分析: ' + rootCauseText : ''}

历史相似工单:
${similarCasesText}

备件库存:
${_formatSpareParts(parts)}

请返回 JSON 格式的详细解决方案，包括：
- steps: 处理步骤数组 [{ step, action, notes }]
- requiredParts: 所需备件 [{ part_name, quantity, category }]
- estimatedDuration: 预估耗时（如 "2小时"）
- precautions: 安全注意事项
- similarCases: 相似案例参考 [{ id, title, outcome }]
- rootCause: 根因总结
- tools: 所需工具列表
`;

    try {
      const result = await llmService.structuredOutput({
        prompt: solutionPrompt,
        systemPrompt: '你是光伏电站运维解决方案专家。请根据工单信息和根因分析生成详细的处理方案。严格以 JSON 格式返回。',
        schema: SOLUTION_SCHEMA,
        maxTokens: 2048,
        temperature: 0.1,
      });

      const data = result.data || {};
      return {
        workOrderId: wo.id,
        steps: data.steps || [],
        requiredParts: data.requiredParts || [],
        estimatedDuration: data.estimatedDuration || '待评估',
        precautions: data.precautions || [],
        similarCases: data.similarCases || [],
        rootCause: data.rootCause || rootCauseText || '待分析',
        tools: data.tools || [],
        model: result.model,
        fallback: !result.valid,
      };
    } catch (error) {
      console.error('[WorkorderIntelligenceService] Solution recommendation failed, using fallback:', error.message);
      return _buildFallbackSolution(wo);
    }
  },

  /**
   * Generate a structured completion report for a work order.
   *
   * Queries the complete work order history (creation, processing, notes)
   * and uses LLM to generate a structured completion report.
   *
   * @param {number} workOrderId - Work order ID
   * @returns {Promise<{
   *   summary: string,
   *   actionsTaken: Array<string>,
   *   partsUsed: Array<{ part_name: string, quantity: number }>,
   *   recommendations: Array<string>,
   *   followUpNeeded: boolean,
   *   followUpActions: Array<string>,
   *   lessonsLearned: string,
   *   model: string,
   *   fallback: boolean
   * }>}
   */
  async generateCompletionReport(workOrderId) {
    const wo = workorderService.getById(workOrderId);
    if (!wo) {
      throw new Error(`Work order not found: ${workOrderId}`);
    }

    if (!['completed', 'closed'].includes(wo.status)) {
      throw new Error(`Work order status is '${wo.status}', must be 'completed' or 'closed' to generate report`);
    }

    const station = wo.station_id ? _getStationInfo(wo.station_id) : null;

    // Calculate processing time
    let processingTime = null;
    if (wo.created_at && wo.completed_at) {
      const created = new Date(wo.created_at.replace(' ', 'T') + 'Z');
      const completed = new Date(wo.completed_at.replace(' ', 'T') + 'Z');
      const hours = (completed - created) / (1000 * 60 * 60);
      processingTime = `${hours.toFixed(1)} 小时`;
    }

    // Get alert root cause if available
    let rootCauseText = '';
    if (wo.alert_id) {
      const rc = await _getRootCause(wo.alert_id);
      if (rc && rc.root_cause) {
        rootCauseText = rc.root_cause;
      }
    }

    const context = {
      workOrderId: wo.id,
      workOrderTitle: wo.title,
      workOrderDescription: wo.description || '无描述',
      workOrderType: wo.type,
      workOrderPriority: wo.priority,
      stationName: station?.name || '未关联电站',
      assignee: wo.assignee || '未分配',
      processingTime: processingTime || '未知',
      rootCause: rootCauseText || '未进行根因分析',
      notes: _formatNotes(wo.notes),
      completedAt: wo.completed_at || '未知',
    };

    let prompt;
    try {
      prompt = llmService.loadPrompt('workorder-recommend.md', context);
    } catch (err) {
      console.error('[WorkorderIntelligenceService] Failed to load prompt:', err.message);
      return _buildFallbackReport(wo, wo.notes);
    }

    const reportPrompt = `
你是光伏运维报告生成专家。请根据以下工单完整历史，生成结构化的完工报告：

- 工单ID: ${wo.id}
- 工单标题: ${wo.title}
- 工单描述: ${wo.description || '无描述'}
- 工单类型: ${wo.type}
- 优先级: ${wo.priority}
- 电站: ${station?.name || '未关联电站'}
- 处理人员: ${wo.assignee || '未分配'}
- 处理时长: ${processingTime || '未知'}
- 完成时间: ${wo.completed_at || '未知'}
${rootCauseText ? '\n- 根因分析: ' + rootCauseText : ''}

处理备注历史:
${_formatNotes(wo.notes)}

请根据以上信息生成结构化的完工报告，返回 JSON 格式：
- summary: 工单处理总结
- actionsTaken: 已采取的措施列表
- partsUsed: 使用的备件 [{ part_name, quantity }]（如备注中未提及则为空）
- recommendations: 后续建议
- followUpNeeded: 是否需要后续跟进 (true/false)
- followUpActions: 后续跟进行动列表（如不需要则为空）
- lessonsLearned: 经验教训总结
`;

    try {
      const result = await llmService.structuredOutput({
        prompt: reportPrompt,
        systemPrompt: '你是光伏电站运维报告生成专家。请根据工单历史记录生成专业的完工报告。严格以 JSON 格式返回。',
        schema: COMPLETION_REPORT_SCHEMA,
        maxTokens: 2048,
        temperature: 0.1,
      });

      const data = result.data || {};
      return {
        workOrderId: wo.id,
        workOrderTitle: wo.title,
        stationName: station?.name || '未关联电站',
        assignee: wo.assignee || '未分配',
        processingTime,
        summary: data.summary || '工单已处理完成',
        actionsTaken: data.actionsTaken || [],
        partsUsed: data.partsUsed || [],
        recommendations: data.recommendations || [],
        followUpNeeded: data.followUpNeeded || false,
        followUpActions: data.followUpActions || [],
        lessonsLearned: data.lessonsLearned || '',
        model: result.model,
        fallback: !result.valid,
      };
    } catch (error) {
      console.error('[WorkorderIntelligenceService] Completion report generation failed, using fallback:', error.message);
      return _buildFallbackReport(wo, wo.notes);
    }
  },

  /**
   * Analyze work order trends for a station over a time window.
   *
   * Computes statistics by type/priority/status/resolution time,
   * then uses LLM to identify patterns and generate recommendations.
   *
   * @param {number} stationId - Station ID to analyze
   * @param {number} [days=30] - Number of days to look back
   * @returns {Promise<{
   *   station: { id: number, name: string },
   *   time_range: { start: string, end: string, days: number },
   *   statistics: {
   *     totalWorkOrders: number,
   *     byType: Array,
   *     byPriority: Array,
   *     byStatus: Array,
   *     avgResolutionHours: number,
   *     completionRate: number,
   *   },
   *   patterns: Array<{ pattern: string, description: string, impact: string }>,
   *   recommendations: Array<string>,
   *   summary: string,
   *   model: string,
   *   fallback: boolean
   * }>}
   */
  async analyzeWorkorderTrends(stationId, days = 30) {
    const station = _getStationInfo(stationId);
    if (!station) {
      throw new Error(`Station not found: ${stationId}`);
    }

    const startTime = `-${days} days`;
    const endTime = 'now';

    // Total work orders
    const totalResult = db.prepare(`
      SELECT COUNT(*) as count FROM work_orders
      WHERE station_id = ?
        AND created_at >= datetime(?)
        AND created_at <= datetime(?)
    `).get(stationId, startTime, endTime);
    const total = totalResult?.count || 0;

    // By type
    const byType = db.prepare(`
      SELECT type, COUNT(*) as count,
        SUM(CASE WHEN priority IN ('high', 'urgent') THEN 1 ELSE 0 END) as high_priority_count
      FROM work_orders
      WHERE station_id = ? AND created_at >= datetime(?) AND created_at <= datetime(?)
      GROUP BY type
      ORDER BY count DESC
    `).all(stationId, startTime, endTime);

    // By priority
    const byPriority = db.prepare(`
      SELECT priority, COUNT(*) as count
      FROM work_orders
      WHERE station_id = ? AND created_at >= datetime(?) AND created_at <= datetime(?)
      GROUP BY priority
      ORDER BY
        CASE priority
          WHEN 'urgent' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
        END
    `).all(stationId, startTime, endTime);

    // By status
    const byStatus = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM work_orders
      WHERE station_id = ? AND created_at >= datetime(?) AND created_at <= datetime(?)
      GROUP BY status
      ORDER BY count DESC
    `).all(stationId, startTime, endTime);

    // Average resolution time (for completed/closed work orders)
    const resolutionResult = db.prepare(`
      SELECT AVG(
        (julianday(completed_at) - julianday(created_at)) * 24
      ) as avg_hours
      FROM work_orders
      WHERE station_id = ?
        AND created_at >= datetime(?)
        AND created_at <= datetime(?)
        AND status IN ('completed', 'closed')
        AND completed_at IS NOT NULL
    `).get(stationId, startTime, endTime);
    const avgResolutionHours = resolutionResult?.avg_hours
      ? parseFloat(resolutionResult.avg_hours.toFixed(1))
      : 0;

    // Completion rate
    const completedCount = db.prepare(`
      SELECT COUNT(*) as count FROM work_orders
      WHERE station_id = ? AND created_at >= datetime(?) AND created_at <= datetime(?)
        AND status IN ('completed', 'closed')
    `).get(stationId, startTime, endTime);
    const completionRate = total > 0
      ? parseFloat(((completedCount.count / total) * 100).toFixed(1))
      : 0;

    // Recent work orders for context
    const recentWOs = db.prepare(`
      SELECT id, title, type, priority, status, created_at, completed_at, assignee
      FROM work_orders
      WHERE station_id = ? AND created_at >= datetime(?) AND created_at <= datetime(?)
      ORDER BY created_at DESC
      LIMIT 50
    `).all(stationId, startTime, endTime);

    // Pending/overdue work orders
    const pendingCount = db.prepare(`
      SELECT COUNT(*) as count FROM work_orders
      WHERE station_id = ? AND status IN ('pending', 'assigned')
    `).get(stationId).count;

    const overdueCount = db.prepare(`
      SELECT COUNT(*) as count FROM work_orders
      WHERE station_id = ?
        AND created_at < datetime('-7 days')
        AND status IN ('pending', 'assigned', 'in_progress')
    `).get(stationId).count;

    const statistics = {
      totalWorkOrders: total,
      byType: byType,
      byPriority: byPriority,
      byStatus: byStatus,
      avgResolutionHours,
      completionRate,
      pendingWorkOrders: pendingCount,
      overdueWorkOrders: overdueCount,
      period: days,
    };

    // Build LLM prompt
    const byTypeText = byType.map((t) =>
      `${t.type}: ${t.count}件 (高优先级: ${t.high_priority_count})`
    ).join('\n') || '无数据';

    const byPriorityText = byPriority.map((p) =>
      `${p.priority}: ${p.count}件`
    ).join('\n') || '无数据';

    const byStatusText = byStatus.map((s) =>
      `${s.status}: ${s.count}件`
    ).join('\n') || '无数据';

    const recentWOsText = recentWOs.map((w, i) =>
      `${i + 1}. [${w.type}/${w.priority}] ${w.title} — 状态: ${w.status}, 处理人: ${w.assignee || '未分配'}`
    ).join('\n') || '无';

    const trendPrompt = `
你是光伏运维趋势分析专家。请分析以下电站的工单趋势数据：

电站: ${station.name}
分析周期: 过去 ${days} 天

统计概览:
- 工单总数: ${total} 件
- 完成率: ${completionRate}%
- 平均处理时长: ${avgResolutionHours} 小时
- 待处理工单: ${pendingCount} 件
- 超期工单: ${overdueCount} 件

按类型分布:
${byTypeText}

按优先级分布:
${byPriorityText}

按状态分布:
${byStatusText}

近期工单列表:
${recentWOsText}

请分析工单趋势和模式，返回 JSON 格式：
- patterns: 发现的模式 [{ pattern, description, impact }]
- recommendations: 改进建议（具体可执行的行动项）
- summary: 趋势分析总结
`;

    try {
      const result = await llmService.structuredOutput({
        prompt: trendPrompt,
        systemPrompt: `你是光伏电站运维趋势分析专家。请分析该电站过去${days}天的工单数据，识别模式和趋势，给出优化建议。严格以 JSON 格式返回。`,
        schema: TREND_SCHEMA,
        maxTokens: 2048,
        temperature: 0.1,
      });

      const data = result.data || {};
      return {
        station: { id: station.id, name: station.name },
        time_range: {
          start: new Date(Date.now() - days * 86400000).toISOString(),
          end: new Date().toISOString(),
          days,
        },
        statistics: data.statistics || statistics,
        patterns: data.patterns || [],
        recommendations: data.recommendations || [],
        summary: data.summary || '趋势分析完成',
        model: result.model,
        fallback: !result.valid,
      };
    } catch (error) {
      console.error('[WorkorderIntelligenceService] Trend analysis failed, using fallback:', error.message);
      return _buildFallbackTrend(statistics);
    }
  },
};

module.exports = workorderIntelligenceService;
