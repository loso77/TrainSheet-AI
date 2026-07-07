import {
  json, readJson, requireToken, rateLimit, usageStatus, consumeDaily,
  ip, num, normalizeRows, parseSheetConfig, publicError,
  getCorrectionExamples, correctionExamplesPrompt
} from '../_lib/shared.js';

function splitDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!m) throw publicError('图片格式不受支持。', 400);
  const ext = m[1] === 'jpeg' ? 'jpeg' : m[1];
  return { mimeType: `image/${ext}`, base64: m[2] };
}

function tableSpec(entries) {
  const nums = entries.map(x => x.table_no);
  const continuous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  return continuous ? `${nums[0]}至${nums[nums.length - 1]}（共${nums.length}个）` : `${nums.join('、')}（共${nums.length}个）`;
}

function buildPrompt(config, examples) {
  const firstTable = config.entries[0].table_no;
  const trainMin = String(config.train_number.min).padStart(3, '0');
  const trainMax = String(config.train_number.max).padStart(3, '0');

  return `你是车表照片识别助手。请只识别本次表号对应的车号和股道，保持快速、稳定、简洁。

本次表号：${tableSpec(config.entries)}。
只识别两项：车号、股道。不要识别时间，时间由系统填写。
车号范围：${trainMin}至${trainMax}。同一张表内车号不能重复，股道不能重复。
A=东，C=西，箭头不属于股道。表号右侧的1或2是无关列，必须忽略。
不要假设某个表号固定对应某个车号或股道。

涂改处理采用轻量规则：
- 明显被划掉的旧值不要作为最终值。
- 旁边未划掉的新写值优先作为最终值。
- 如果涂改太复杂、看不清或不敢确定，就把该字段留空，并设置 ambiguity=true。
- 不需要解释每一处涂改，不要输出长说明。

只返回JSON对象，不要Markdown。每个表号必须返回一行：
{"rows":[{"table_no":${firstTable},"train_number":"","track_name":"","ambiguity":false,"confidence":0.0}]}

字段说明：
- table_no：表号
- train_number：三位车号，看不清可留空
- track_name：如1东、12西，看不清可留空
- ambiguity：是否不确定
- confidence：0到1之间的把握程度`;
}

function getProvider(env) {
  const explicit = String(env.MODEL_PROVIDER || '').toLowerCase().trim();
  if (explicit === 'gemini' || explicit === 'google') return 'gemini';
  if (explicit === 'openai') return 'openai';
  if (env.GEMINI_API_KEY) return 'gemini';
  const url = String(env.OPENAI_API_URL || '');
  const model = String(env.OPENAI_MODEL || env.GEMINI_MODEL || '');
  if (url.includes('generativelanguage.googleapis.com') || model.toLowerCase().includes('gemini')) return 'gemini';
  return 'openai';
}

async function withTimeout(promiseFactory, ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('model-timeout'), ms);
  try {
    return await promiseFactory(controller.signal);
  } catch (error) {
    if (error?.name === 'AbortError' || String(error).includes('model-timeout')) {
      throw publicError(`大模型响应超过${Math.round(ms / 1000)}秒，本次未计次数。`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p?.text || '').join('').trim();
  if (text) return text;
  const reason = data?.candidates?.[0]?.finishReason;
  if (reason) throw publicError(`Gemini没有返回文本，结束原因：${reason}；本次未计次数。`, 502);
  throw publicError('Gemini没有返回可解析文本，本次未计次数。', 502);
}

function cleanJsonText(text) {
  return String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
}

async function callGeminiOfficial({ env, prompt, image, timeoutMs, debugTextOnly = false }) {
  const apiKey = env.GEMINI_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) throw publicError('缺少 GEMINI_API_KEY 或 OPENAI_API_KEY。', 500);
  const model = env.GEMINI_MODEL || env.OPENAI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const parts = [{ text: debugTextOnly ? '只返回 {"ok":true,"message":"debug"} 这个JSON对象。' : prompt }];
  if (!debugTextOnly) {
    const { mimeType, base64 } = splitDataUrl(image);
    parts.push({ inline_data: { mime_type: mimeType, data: base64 } });
  }

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0,
      response_mime_type: 'application/json'
    }
  };

  const r = await withTimeout(signal => fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), timeoutMs);

  const rawText = await r.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch {}

  if (!r.ok) {
    const detail = data?.error?.message || rawText || `HTTP ${r.status}`;
    if (r.status === 429) throw publicError('Gemini请求过于频繁或额度受限，本次未计次数。', 429);
    if (r.status === 503) throw publicError('Gemini当前繁忙，本次未计次数，请稍后重试。', 503);
    if (r.status >= 500) throw publicError(`Gemini服务暂时不可用（${r.status}），本次未计次数。`, 503);
    throw publicError('Gemini接口错误：' + String(detail).slice(0, 350) + '；本次未计次数。', 502);
  }

  return { text: extractGeminiText(data), provider: 'gemini', model };
}

async function callOpenAICompatible({ env, prompt, image, timeoutMs, debugTextOnly = false }) {
  if (!env.OPENAI_API_KEY) throw publicError('缺少 OPENAI_API_KEY。', 500);
  const model = env.OPENAI_MODEL || 'gpt-4.1-mini';
  const url = env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';

  const content = debugTextOnly
    ? [{ type: 'text', text: '只返回 {"ok":true,"message":"debug"} 这个JSON对象。' }]
    : [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image, detail: 'high' } }];

  const r = await withTimeout(signal => fetch(url, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }]
    })
  }), timeoutMs);

  const rawText = await r.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch {}

  if (!r.ok) {
    const detail = data?.error?.message || data?.message || rawText || `HTTP ${r.status}`;
    if (r.status === 429) throw publicError('大模型请求过于频繁或额度受限，本次未计次数。', 429);
    if (r.status === 503) throw publicError('大模型当前繁忙，本次未计次数，请稍后重试。', 503);
    if (r.status >= 500) throw publicError(`大模型服务暂时不可用（${r.status}），本次未计次数。`, 503);
    throw publicError('大模型接口错误：' + String(detail).slice(0, 350) + '；本次未计次数。', 502);
  }

  let modelText = data?.choices?.[0]?.message?.content;
  if (Array.isArray(modelText)) modelText = modelText.map(x => typeof x === 'string' ? x : (x?.text || '')).join('');
  if (typeof modelText !== 'string') modelText = data?.output_text || data?.text;
  if (typeof modelText !== 'string') throw publicError('大模型没有返回可解析结果，本次未计次数。', 502);

  return { text: modelText, provider: 'openai-compatible', model };
}

async function callModel(args) {
  const provider = getProvider(args.env);
  if (provider === 'gemini') return await callGeminiOfficial(args);
  return await callOpenAICompatible(args);
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) throw publicError('D1 数据库尚未绑定。', 503);
  const p = await requireToken(request, env);

  const [ipOk, deviceOk] = await Promise.all([
    rateLimit(env.DB, 'recognize-ip', ip(request), 4, 60),
    rateLimit(env.DB, 'recognize-device', p.sub, 3, 60)
  ]);
  if (!ipOk || !deviceOk) throw publicError('请求过于频繁，请稍后再试。', 429);

  const max = num(env.MAX_REQUEST_BYTES, 9000000);
  const body = await readJson(request, max);
  if (typeof body.image !== 'string') splitDataUrl(body.image);
  if (body.image.length > max) throw publicError('压缩后的图片过大。', 413);

  const config = parseSheetConfig(body.config);
  const dl = num(env.DEVICE_DAILY_LIMIT, 30);
  const gl = num(env.GLOBAL_DAILY_LIMIT, 50);

  const beforeUsage = await usageStatus(env.DB, p.sub);
  if (beforeUsage.global_used >= gl) throw publicError('今日服务总额度已用完。', 429);
  if (beforeUsage.device_used >= dl) throw publicError('这台设备今日识别次数已用完。', 429);

  const examples = await getCorrectionExamples(env.DB, 0); // 轻量稳定版关闭历史案例，先保证识别能稳定返回。
  const prompt = buildPrompt(config, examples);
  const timeoutMs = Math.max(15000, Math.min(55000, num(env.MODEL_TIMEOUT_MS, 35000)));

  const started = Date.now();
  const result = await callModel({ env, prompt, image: body.image, timeoutMs });
  const elapsed_ms = Date.now() - started;

  const modelText = cleanJsonText(result.text);
  let parsed;
  try { parsed = JSON.parse(modelText); } catch {
    throw publicError('大模型返回的 JSON 无效：' + modelText.slice(0, 240) + '；本次未计次数。', 502);
  }

  const normalizedRows = normalizeRows(parsed.rows, config);

  const used = await consumeDaily(env.DB, p.sub, dl, gl);

  return json({
    rows: normalizedRows,
    config_used: config,
    memory_examples_used: examples.length,
    model_provider: result.provider,
    model_name: result.model,
    elapsed_ms,
    model_timeout_ms: timeoutMs,
    usage: { ...used, global_limit: gl, device_limit: dl, expires_at: p.exp }
  });
}

// 供 /api/debug-model 复用
export async function debugModel(request, env) {
  const p = await requireToken(request, env);
  const timeoutMs = Math.max(8000, Math.min(30000, num(env.MODEL_TIMEOUT_MS, 15000)));
  const started = Date.now();
  const result = await callModel({ env, prompt: '', image: '', timeoutMs, debugTextOnly: true });
  const text = cleanJsonText(result.text);
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
  return json({
    ok: true,
    provider: result.provider,
    model: result.model,
    elapsed_ms: Date.now() - started,
    response: parsed,
    token_ok: !!p?.sub
  });
}
