/**
 * Unified LLM Service — DashScope / OpenAI-compatible provider
 *
 * Provides a single entry point for all LLM interactions across the platform:
 *   - chat()           — text completion (qwen-plus)
 *   - chatStream()     — streaming text completion (SSE format)
 *   - visionAnalyze()  — image + text analysis (qwen-vl-max)
 *   - embed()          — text embedding (text-embedding-v3)
 *   - structuredOutput() — forced JSON with schema validation
 *
 * All functions gracefully degrade to mock/error responses when
 * DASHSCOPE_API_KEY is not configured.
 *
 * Uses native https module, matching the style of aiService.js.
 */

const https = require('https');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const getDashScopeApiKey = () => process.env.DASHSCOPE_API_KEY || '';
const DASHSCOPE_HOST = 'dashscope.aliyuncs.com';
const DASHSCOPE_PATH = '/compatible-mode/v1/chat/completions';
const EMBEDDING_PATH = '/compatible-mode/v1/embeddings';

const DEFAULT_MODEL = 'qwen-plus';
const VISION_MODEL = 'qwen-vl-max';
const EMBEDDING_MODEL = 'text-embedding-v3';

const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.3;
const REQUEST_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------
// Prompt template loader
// ---------------------------------------------------------------------------

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const _promptCache = {};

/**
 * Load a markdown prompt template from the prompts directory.
 * Replaces {{variable}} placeholders with values from the context object.
 *
 * @param {string} name - Template filename (e.g. 'alert-analysis.md')
 * @param {object} [context={}] - Key-value pairs for placeholder substitution
 * @returns {string} Rendered prompt text
 */
function loadPrompt(name, context = {}) {
  // Resolve cache key
  const cacheKey = `${name}:${JSON.stringify(context)}`;
  if (_promptCache[cacheKey]) {
    return _promptCache[cacheKey];
  }

  const filePath = path.join(PROMPTS_DIR, name);
  let template;
  try {
    template = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error(`[LLM Service] Prompt template not found: ${filePath}`);
    throw new Error(`Prompt template not found: ${name}`);
  }

  // Replace {{key}} placeholders
  let rendered = template;
  for (const [key, value] of Object.entries(context)) {
    const re = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    rendered = rendered.replace(re, String(value ?? ''));
  }

  _promptCache[cacheKey] = rendered;
  return rendered;
}

/**
 * Clear the prompt template cache (useful during development).
 */
function clearPromptCache() {
  for (const key of Object.keys(_promptCache)) {
    delete _promptCache[key];
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the DashScope API key is configured.
 *
 * @returns {boolean}
 */
function isConfigured() {
  const key = getDashScopeApiKey();
  return key && key.startsWith('sk-');
}

/**
 * Generic HTTPS POST to a DashScope endpoint.
 *
 * @param {string} endpointPath - API path (e.g. /compatible-mode/v1/chat/completions)
 * @param {object} payload      - Request body object
 * @param {number} [timeout]    - Timeout in ms
 * @returns {Promise<object>}   - Parsed JSON response
 */
function dashscopePost(endpointPath, payload, timeout = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

    const options = {
      hostname: DASHSCOPE_HOST,
      path: endpointPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getDashScopeApiKey()}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
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

    req.write(body);
    req.end();
  });
}

/**
 * Generic HTTPS POST that returns a readable stream (for SSE).
 *
 * @param {string} endpointPath
 * @param {object} payload
 * @param {object} [options]   - { onChunk, onDone, onError, timeout }
 * @returns {{ destroy: Function }} Handle to abort the request
 */
function dashscopePostStream(endpointPath, payload, options = {}) {
  const { onChunk, onDone, onError, timeout = REQUEST_TIMEOUT_MS } = options;
  const body = JSON.stringify(payload);

  const reqOptions = {
    hostname: DASHSCOPE_HOST,
    path: endpointPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Authorization': `Bearer ${getDashScopeApiKey()}`,
      'Content-Length': Buffer.byteLength(body),
    },
    timeout,
  };

  let buffer = '';
  const req = https.request(reqOptions, (res) => {
    if (res.statusCode !== 200) {
      let errData = '';
      res.on('data', (c) => { errData += c; });
      res.on('end', () => {
        const handler = onError || console.error;
        handler(new Error(`DashScope streaming error ${res.statusCode}: ${errData.slice(0, 300)}`));
      });
      return;
    }

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Keep the last incomplete line in the buffer
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payloadStr = trimmed.slice(5).trim();
        if (payloadStr === '[DONE]') {
          if (onDone) onDone();
          return;
        }
        try {
          const parsed = JSON.parse(payloadStr);
          if (onChunk) onChunk(parsed);
        } catch (e) {
          // Skip unparseable chunks
        }
      }
    });

    res.on('end', () => {
      if (onDone) onDone();
    });
  });

  req.on('error', (err) => {
    if (onError) onError(err);
    else console.error('[LLM Service] Stream error:', err.message);
  });

  req.on('timeout', () => {
    req.destroy();
    const err = new Error('DashScope streaming request timed out');
    if (onError) onError(err);
  });

  req.write(body);
  req.end();

  return { destroy: () => req.destroy() };
}

/**
 * Extract JSON from a text response, trying multiple strategies.
 * Re-export of the logic from aiService.js for consistency.
 *
 * @param {string} text
 * @returns {object|null}
 */
function parseJSONFromText(text) {
  try { return JSON.parse(text); } catch (e) { /* continue */ }

  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1].trim()); } catch (e) { /* continue */ }
  }

  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch (e) { /* continue */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a chat completion request.
 *
 * @param {object} params
 * @param {string} [params.model=DEFAULT_MODEL]   - Model identifier
 * @param {string} params.prompt                   - User prompt text
 * @param {string} [params.systemPrompt]           - Optional system prompt
 * @param {Array}  [params.messages]               - Full message array (overrides prompt/systemPrompt)
 * @param {number} [params.maxTokens=DEFAULT_MAX_TOKENS]
 * @param {number} [params.temperature=DEFAULT_TEMPERATURE]
 * @returns {Promise<{text: string, model: string, usage: object}>}
 */
async function chat({
  model = DEFAULT_MODEL,
  prompt,
  systemPrompt,
  messages,
  maxTokens = DEFAULT_MAX_TOKENS,
  temperature = DEFAULT_TEMPERATURE,
} = {}) {
  if (!isConfigured()) {
    return _mockChat(prompt || (messages && messages[messages.length - 1]?.content) || '');
  }

  try {
    let msgArray = messages;
    if (!msgArray) {
      msgArray = [];
      if (systemPrompt) msgArray.push({ role: 'system', content: systemPrompt });
      msgArray.push({ role: 'user', content: prompt });
    }

    const payload = {
      model,
      messages: msgArray,
      max_tokens: maxTokens,
      temperature,
    };

    const response = await dashscopePost(DASHSCOPE_PATH, payload);
    const text = response.choices?.[0]?.message?.content || '';

    return {
      text,
      model: response.model || model,
      usage: response.usage || null,
    };
  } catch (error) {
    console.error('[LLM Service] Chat failed, falling back to mock:', error.message);
    return _mockChat(prompt || '');
  }
}

/**
 * Streaming chat completion — calls onChunk for each SSE delta.
 *
 * @param {object} params
 * @param {string} [params.model=DEFAULT_MODEL]
 * @param {string} params.prompt
 * @param {string} [params.systemPrompt]
 * @param {Array}  [params.messages]
 * @param {number} [params.maxTokens=DEFAULT_MAX_TOKENS]
 * @param {number} [params.temperature=DEFAULT_TEMPERATURE]
 * @param {Function} params.onChunk  - Called with { text: string } for each delta
 * @param {Function} [params.onDone] - Called when streaming completes
 * @param {Function} [params.onError]- Called on error
 * @returns {{ destroy: Function }} Handle to abort the stream
 */
function chatStream({
  model = DEFAULT_MODEL,
  prompt,
  systemPrompt,
  messages,
  maxTokens = DEFAULT_MAX_TOKENS,
  temperature = DEFAULT_TEMPERATURE,
  onChunk,
  onDone,
  onError,
} = {}) {
  if (!isConfigured()) {
    const result = _mockChat(prompt || '');
    if (onChunk) onChunk({ text: result.text, done: true });
    if (onDone) onDone();
    return { destroy: () => {} };
  }

  let msgArray = messages;
  if (!msgArray) {
    msgArray = [];
    if (systemPrompt) msgArray.push({ role: 'system', content: systemPrompt });
    msgArray.push({ role: 'user', content: prompt });
  }

  const payload = {
    model,
    messages: msgArray,
    max_tokens: maxTokens,
    temperature,
    stream: true,
  };

  let accumulated = '';
  return dashscopePostStream(DASHSCOPE_PATH, payload, {
    timeout: REQUEST_TIMEOUT_MS,
    onChunk: (parsed) => {
      const delta = parsed.choices?.[0]?.delta?.content || '';
      if (delta) {
        accumulated += delta;
        if (onChunk) onChunk({ text: delta, accumulated });
      }
    },
    onDone: () => {
      if (onDone) onDone({ text: accumulated });
    },
    onError: (err) => {
      console.error('[LLM Service] Stream error, falling back to mock:', err.message);
      const fallback = _mockChat(prompt || '');
      if (onChunk) onChunk({ text: fallback.text, accumulated: fallback.text, done: true });
      if (onDone) onDone({ text: fallback.text });
    },
  });
}

/**
 * Analyze an image with the vision model.
 *
 * @param {object} params
 * @param {string} params.imageBase64  - Data URL (data:image/...;base64,...)
 * @param {string} params.prompt       - Text prompt / question about the image
 * @param {string} [params.systemPrompt] - Optional system prompt
 * @param {number} [params.maxTokens=1024]
 * @param {number} [params.temperature=0.1]
 * @returns {Promise<{text: string, model: string, usage: object}>}
 */
async function visionAnalyze({
  imageBase64,
  prompt,
  systemPrompt = '你是光伏电站运维专家，专门分析光伏组件图像中的缺陷。请用中文回答。',
  maxTokens = 1024,
  temperature = 0.1,
} = {}) {
  if (!isConfigured()) {
    return _mockVisionAnalysis(prompt);
  }

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      },
    ];

    const payload = {
      model: VISION_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature,
    };

    const response = await dashscopePost(DASHSCOPE_PATH, payload);
    const text = response.choices?.[0]?.message?.content || '';

    return {
      text,
      model: response.model || VISION_MODEL,
      usage: response.usage || null,
    };
  } catch (error) {
    console.error('[LLM Service] Vision analysis failed, falling back to mock:', error.message);
    return _mockVisionAnalysis(prompt);
  }
}

/**
 * Generate text embeddings.
 *
 * @param {object} params
 * @param {string|string[]} params.text  - Input text or array of texts
 * @param {string} [params.model=EMBEDDING_MODEL]
 * @returns {Promise<{embeddings: number[][], model: string, usage: object}>}
 */
async function embed({
  text,
  model = EMBEDDING_MODEL,
} = {}) {
  if (!isConfigured()) {
    return _mockEmbed(text);
  }

  try {
    const input = Array.isArray(text) ? text : [text];

    const payload = {
      model,
      input,
    };

    const response = await dashscopePost(EMBEDDING_PATH, payload);

    // DashScope embedding response: { data: [{ embedding: number[] }, ...], usage: {...} }
    const embeddings = (response.data || []).map((d) => d.embedding);

    return {
      embeddings,
      model: response.model || model,
      usage: response.usage || null,
    };
  } catch (error) {
    console.error('[LLM Service] Embedding failed, falling back to mock:', error.message);
    return _mockEmbed(text);
  }
}

/**
 * Force structured JSON output with optional schema validation.
 * Sends response_format: { type: "json_object" } to the model.
 *
 * @param {object} params
 * @param {string} [params.model=DEFAULT_MODEL]
 * @param {string} params.prompt
 * @param {string} [params.systemPrompt]
 * @param {Array}  [params.messages]
 * @param {object} [params.schema]     - JSON schema for validation (best-effort)
 * @param {number} [params.maxTokens=DEFAULT_MAX_TOKENS]
 * @param {number} [params.temperature=0.1]  - Low temp for deterministic JSON
 * @param {number} [params.retries=2]  - Max retries on parse failure
 * @returns {Promise<{data: object|null, raw: string, valid: boolean, model: string}>}
 */
async function structuredOutput({
  model = DEFAULT_MODEL,
  prompt,
  systemPrompt,
  messages,
  schema,
  maxTokens = DEFAULT_MAX_TOKENS,
  temperature = 0.1,
  retries = 2,
} = {}) {
  if (!isConfigured()) {
    const mock = _mockStructuredOutput(prompt || '', schema);
    return { data: mock, raw: JSON.stringify(mock), valid: true, model: 'mock' };
  }

  let msgArray = messages;
  if (!msgArray) {
    msgArray = [];
    if (systemPrompt) msgArray.push({ role: 'system', content: systemPrompt });
    msgArray.push({ role: 'user', content: prompt });
  }

  // Append a JSON instruction to the last user message
  const lastUser = [...msgArray].reverse().find((m) => m.role === 'user');
  if (lastUser && typeof lastUser.content === 'string') {
    lastUser.content += '\n\n请仅返回合法的 JSON 对象，不要添加其他文字或 markdown 代码块。';
  }

  const payload = {
    model,
    messages: msgArray,
    max_tokens: maxTokens,
    temperature,
    response_format: { type: 'json_object' },
  };

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await dashscopePost(DASHSCOPE_PATH, payload);
      const raw = response.choices?.[0]?.message?.content || '';
      const parsed = parseJSONFromText(raw);

      if (parsed !== null) {
        // Best-effort schema validation
        let valid = true;
        if (schema) {
          valid = _validateSchema(parsed, schema);
        }

        return {
          data: parsed,
          raw,
          valid,
          model: response.model || model,
        };
      }

      lastError = new Error('Failed to parse JSON from model response');
    } catch (error) {
      lastError = error;
    }
  }

  console.error('[LLM Service] structuredOutput failed after retries:', lastError?.message);
  const mock = _mockStructuredOutput(prompt || '', schema);
  return { data: mock, raw: JSON.stringify(mock), valid: false, model: 'mock' };
}

// ---------------------------------------------------------------------------
// Schema validation (best-effort, no external deps)
// ---------------------------------------------------------------------------

/**
 * Lightweight JSON schema validation — checks required fields and types.
 *
 * @param {object} obj
 * @param {object} schema - { type: 'object', properties: {...}, required: [...] }
 * @returns {boolean}
 */
function _validateSchema(obj, schema) {
  if (!obj || typeof obj !== 'object') return false;
  if (!schema || schema.type !== 'object') return true;

  // Check required fields
  if (schema.required && Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (!(field in obj)) return false;
    }
  }

  // Check property types
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in obj && propSchema.type) {
        const value = obj[key];
        if (propSchema.type === 'array' && !Array.isArray(value)) return false;
        if (propSchema.type === 'string' && typeof value !== 'string') return false;
        if (propSchema.type === 'number' && typeof value !== 'number') return false;
        if (propSchema.type === 'boolean' && typeof value !== 'boolean') return false;
        if (propSchema.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) return false;
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Mock responses (graceful degradation)
// ---------------------------------------------------------------------------

function _mockChat(prompt) {
  const preview = prompt.slice(0, 80);
  return {
    text: `[Mock] 收到提问: "${preview}${prompt.length > 80 ? '...' : ''}"。当前未配置 DASHSCOPE_API_KEY，返回模拟回复。`,
    model: 'mock',
    usage: null,
  };
}

function _mockVisionAnalysis(prompt) {
  return {
    text: `[Mock] 图像分析模拟结果。Prompt: "${(prompt || '').slice(0, 60)}"。未配置 API Key，建议使用真实图像获取分析结果。`,
    model: 'mock',
    usage: null,
  };
}

function _mockEmbed(text) {
  const input = Array.isArray(text) ? text : [text];
  // Return zero vectors of typical embedding dimension (1024)
  const embeddings = input.map(() => new Array(1024).fill(0));
  return {
    embeddings,
    model: 'mock',
    usage: { total_tokens: input.reduce((s, t) => s + t.length, 0) },
  };
}

function _mockStructuredOutput(prompt, schema) {
  if (schema && schema.required) {
    const mock = {};
    for (const field of schema.required) {
      const propSchema = schema.properties?.[field];
      if (propSchema) {
        if (propSchema.type === 'array') mock[field] = [];
        else if (propSchema.type === 'number') mock[field] = 0;
        else if (propSchema.type === 'boolean') mock[field] = false;
        else if (propSchema.type === 'object') mock[field] = {};
        else mock[field] = '';
      } else {
        mock[field] = '';
      }
    }
    return mock;
  }
  return { message: 'Mock structured output', prompt: prompt.slice(0, 100) };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  chat,
  chatStream,
  visionAnalyze,
  embed,
  structuredOutput,
  isConfigured,
  loadPrompt,
  clearPromptCache,
  parseJSONFromText,
};
