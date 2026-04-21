/**
 * AI Service — DashScope LLM integration
 *
 * Provides:
 *   - analyzeDefectImage(imageBase64, label)  → qwen-vl-max for PV defect detection
 *   - generateDailyReport(reportData)         → qwen-plus for intelligent daily report summary
 *
 * Falls back to high-quality mock results when DASHSCOPE_API_KEY is not configured.
 */

const https = require('https');

// Lazy-load API key to ensure dotenv is loaded first
const getDashScopeApiKey = () => process.env.DASHSCOPE_API_KEY || '';
const DASHSCOPE_BASE_URL = 'dashscope.aliyuncs.com';
const VISION_MODEL = 'qwen-vl-max';
const TEXT_MODEL = 'qwen-plus';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isConfigured() {
  const key = getDashScopeApiKey();
  return key && key.startsWith('sk-');
}

/**
 * Generic HTTPS POST to DashScope OpenAI-compatible endpoint.
 */
function dashscopePost(model, messages, maxTokens = 2048, temperature = 0.1) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    });

    const options = {
      hostname: DASHSCOPE_BASE_URL,
      path: '/compatible-mode/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getDashScopeApiKey()}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 60000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(new Error('Failed to parse DashScope response: ' + e.message));
          }
        } else {
          reject(new Error(`DashScope API error ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('DashScope API request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Image analysis — qwen-vl-max
// ---------------------------------------------------------------------------

/**
 * Analyze a PV defect image using qwen-vl-max vision model.
 *
 * @param {string} imageBase64  - Data URL (data:image/...;base64,...)
 * @param {string} label        - Human-readable label for the image
 * @returns {Promise<object>}   - { defects, overall_health, recommendation }
 */
async function analyzeDefectImage(imageBase64, label) {
  if (!isConfigured()) {
    return getMockDefectAnalysis(label);
  }

  try {
    const messages = [
      {
        role: 'system',
        content: '你是光伏电站运维专家，专门负责通过无人机/手持设备拍摄的光伏组件图像进行缺陷分析。请用中文回答。识别缺陷类型、位置和严重程度，并给出运维建议。',
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: imageBase64 },
          },
          {
            type: 'text',
            text: '请分析这张光伏组件图像，识别所有可见缺陷。请按以下JSON格式返回结果（不要添加其他文字）：\n' +
              '{\n' +
              '  "defects": [\n' +
              '    {"type": "缺陷类型(hot_spot/crack/shadow/dirt/other)", "confidence": 0.0-1.0, "severity": "high/medium/low", "description": "缺陷描述"}\n' +
              '  ],\n' +
              '  "overall_health": "good/degraded/critical",\n' +
              '  "recommendation": "运维建议"\n' +
              '}',
          },
        ],
      },
    ];

    const response = await dashscopePost(VISION_MODEL, messages, 1024, 0.1);
    const content = response.choices?.[0]?.message?.content || '';

    // Try to parse JSON from the response
    const parsed = parseJSONFromText(content);
    if (parsed && parsed.defects) {
      return {
        defects: parsed.defects,
        overall_health: parsed.overall_health || 'degraded',
        recommendation: parsed.recommendation || '建议进一步检查',
        model_used: VISION_MODEL,
      };
    }

    // If JSON parse failed, return the text as a recommendation
    return {
      defects: [{ type: 'visual_analysis', confidence: 0.8, severity: 'medium', description: content.slice(0, 500) }],
      overall_health: 'degraded',
      recommendation: content.slice(0, 500),
      model_used: VISION_MODEL,
    };
  } catch (error) {
    console.error('[AI Service] Vision analysis failed, falling back to mock:', error.message);
    return getMockDefectAnalysis(label);
  }
}

/**
 * High-quality mock defect analysis (fallback when no API key).
 */
function getMockDefectAnalysis(label) {
  const labelLower = (label || '').toLowerCase();

  // Context-aware mock results based on image label
  if (labelLower.includes('热斑') || labelLower.includes('hot_spot')) {
    return {
      defects: [
        { type: 'hot_spot', confidence: 0.94, severity: 'high', description: '检测到明显热斑区域，位于组件中部偏左，呈现典型的高温特征' },
        { type: 'crack', confidence: 0.62, severity: 'medium', description: '热斑边缘可见微小裂纹，可能是热应力导致' },
      ],
      overall_health: 'degraded',
      recommendation: '⚠️ 发现严重热斑缺陷。建议：\n1. 立即安排现场巡检确认\n2. 使用红外热像仪测量温度分布\n3. 检查接线盒和旁路二极管工作状态\n4. 如确认热斑严重，建议更换该组件\n5. 检查组串电流，评估发电量损失',
      model_used: 'mock',
    };
  }

  if (labelLower.includes('隐裂') || labelLower.includes('crack')) {
    return {
      defects: [
        { type: 'crack', confidence: 0.88, severity: 'high', description: '检测到多条隐裂纹，贯穿多个电池片，存在断裂风险' },
        { type: 'hot_spot', confidence: 0.45, severity: 'low', description: '裂纹附近可能出现局部发热' },
      ],
      overall_health: 'critical',
      recommendation: '🔴 检测到严重隐裂缺陷。建议：\n1. 立即断电检查，防止裂纹扩展\n2. 使用EL检测设备确认内部损伤程度\n3. 评估更换组件的必要性\n4. 检查安装支架是否变形导致应力集中',
      model_used: 'mock',
    };
  }

  if (labelLower.includes('遮挡') || labelLower.includes('shadow')) {
    return {
      defects: [
        { type: 'shadow', confidence: 0.91, severity: 'medium', description: '检测到明显遮挡区域，影响多个电池片的光照接收' },
      ],
      overall_health: 'degraded',
      recommendation: '🟡 检测到遮挡缺陷。建议：\n1. 检查遮挡物来源（树木、建筑、灰尘堆积等）\n2. 如为植被遮挡，安排修剪\n3. 如为异物遮挡，及时清理\n4. 评估遮挡对组串功率的影响程度',
      model_used: 'mock',
    };
  }

  if (labelLower.includes('污秽') || labelLower.includes('dirt')) {
    return {
      defects: [
        { type: 'dirt', confidence: 0.87, severity: 'medium', description: '组件表面存在明显污秽堆积，影响透光率' },
      ],
      overall_health: 'degraded',
      recommendation: '🟡 检测到污秽缺陷。建议：\n1. 安排清洗作业，恢复组件透光率\n2. 评估清洗频率，如污染严重可考虑增加清洗周期\n3. 检查附近是否有污染源（工厂、工地等）\n4. 清洗后复测组串功率，确认发电效率恢复',
      model_used: 'mock',
    };
  }

  // Generic fallback
  return {
    defects: [
      { type: 'unknown', confidence: 0.70, severity: 'medium', description: '检测到组件表面存在异常区域，需进一步确认缺陷类型' },
    ],
    overall_health: 'degraded',
    recommendation: '建议安排现场巡检，使用专业设备（红外热像仪、EL检测仪）进一步确认缺陷类型和程度。',
    model_used: 'mock',
  };
}

// ---------------------------------------------------------------------------
// Daily report generation — qwen-plus
// ---------------------------------------------------------------------------

/**
 * Generate an intelligent daily report summary using qwen-plus.
 *
 * @param {object} reportData - { station, generation, weather, performance, alerts }
 * @returns {Promise<string>} - AI-generated report summary text
 */
async function generateDailyReportSummary(reportData) {
  if (!isConfigured()) {
    return getMockReportSummary(reportData);
  }

  try {
    const { station, generation, weather, performance, alerts } = reportData;

    const prompt = `你是光伏电站运维专家。请根据以下数据，生成一份专业的运维日报摘要（中文）。

电站信息：
- 名称：${station.name}
- 装机容量：${station.capacity_mw} MW

发电数据：
- 总发电量：${generation.total_energy_kwh.toFixed(1)} kWh
- 峰值功率：${generation.peak_power_kw.toFixed(1)} kW
- 平均功率：${generation.avg_power_kw.toFixed(1)} kW
- 有效读数：${generation.reading_count} 条

气象数据：
- 平均辐照度：${weather.avg_irradiance_wm2} W/m²
- 峰值辐照度：${weather.peak_irradiance_wm2} W/m²
- 平均温度：${weather.avg_temperature_c}°C
- 平均风速：${weather.avg_wind_speed_ms} m/s

性能指标：
- 性能比 PR：${performance.performance_ratio}%
- 告警总数：${performance.alerts_count} 条
- 告警分布：严重${performance.alerts_by_severity?.critical || 0}条、警告${performance.alerts_by_severity?.warning || 0}条、提示${performance.alerts_by_severity?.info || 0}条

请生成一段200-300字的日报摘要，包括：
1. 当日发电情况总体评价
2. 气象条件分析
3. 性能评估
4. 运维建议（如有告警或异常）

直接输出摘要内容，不要使用JSON格式。`;

    const messages = [
      { role: 'system', content: '你是光伏电站运维AI助手，负责生成专业、简洁的运维日报摘要。' },
      { role: 'user', content: prompt },
    ];

    const response = await dashscopePost(TEXT_MODEL, messages, 1024, 0.3);
    return response.choices?.[0]?.message?.content || getMockReportSummary(reportData);
  } catch (error) {
    console.error('[AI Service] Report generation failed, falling back to mock:', error.message);
    return getMockReportSummary(reportData);
  }
}

/**
 * Rule-based mock daily report summary (fallback).
 */
function getMockReportSummary(reportData) {
  const { station, generation, weather, performance, alerts } = reportData;

  // Weather assessment
  let weatherComment;
  if (weather.peak_irradiance_wm2 > 800) {
    weatherComment = '今日辐照条件优秀，峰值辐照度达到' + weather.peak_irradiance_wm2 + ' W/m²，为发电提供了良好的气象条件';
  } else if (weather.peak_irradiance_wm2 > 500) {
    weatherComment = '今日辐照条件较好，峰值辐照度' + weather.peak_irradiance_wm2 + ' W/m²，有利于光伏发电';
  } else if (weather.avg_irradiance_wm2 > 200) {
    weatherComment = '今日辐照条件一般，平均辐照度' + weather.avg_irradiance_wm2 + ' W/m²，发电量处于正常水平';
  } else {
    weatherComment = '今日辐照条件偏弱，平均辐照度仅' + weather.avg_irradiance_wm2 + ' W/m²，对发电量造成了一定影响';
  }

  // Performance assessment
  let perfComment;
  if (performance.performance_ratio >= 80) {
    perfComment = '性能比PR达到' + performance.performance_ratio + '%，系统运行状态良好';
  } else if (performance.performance_ratio >= 60) {
    perfComment = '性能比PR为' + performance.performance_ratio + '%，略低于预期，建议关注异常组串';
  } else {
    perfComment = '性能比PR仅' + performance.performance_ratio + '%，明显偏低，需要排查系统异常';
  }

  // Alert comment
  let alertComment = '';
  if (performance.alerts_count > 0) {
    alertComment = `今日共产生${performance.alerts_count}条告警，请及时处理，避免影响发电效率。`;
  }

  return `${station.name}运维日报摘要：\n\n今日电站总发电量${generation.total_energy_kwh.toFixed(1)} kWh，峰值功率${generation.peak_power_kw.toFixed(1)} kW。${weatherComment}。${perfComment}。${alertComment}\n\n建议：持续关注异常组串运行状态，定期巡检维护，确保电站安全稳定运行。`;
}

// ---------------------------------------------------------------------------
// JSON extraction helper
// ---------------------------------------------------------------------------

function parseJSONFromText(text) {
  // Try direct parse
  try { return JSON.parse(text); } catch (e) { /* continue */ }

  // Try to find JSON block
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1].trim()); } catch (e) { /* continue */ }
  }

  // Try to find { ... } block
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch (e) { /* continue */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  analyzeDefectImage,
  generateDailyReportSummary,
  isConfigured,
};
