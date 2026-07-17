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
  const memoryPrompt = correctionExamplesPrompt(examples);

  return `你是轨道交通手写车表识别助手。任务不只是OCR，而是判断每一行当前仍然有效的最终内容。

本次表号：${tableSpec(config.entries)}。
表号是每行的定位锚点。即使纸张弯折或表格线倾斜，也要从印刷表号所在行寻找其右侧的车号和股道。
只识别两项：车号、股道。不要识别时间，时间由系统填写。表号右侧的1或2是无关列，必须忽略。
车号范围：${trainMin}至${trainMax}。同一张表内车号不能重复，股道不能重复。
A=东，C=西，箭头不属于股道。
不要假设某个表号固定对应某个车号或股道。

编辑动作语义（必须严格执行）：
- 被横线、斜线、叉号或明显涂抹划掉的内容等同删除，绝不能作为最终值。
- 在被删除内容旁边、上方或下方重新写的未划掉内容，是新的候选值；能明确对应同一行时，应作为最终值。
- 若新增内容后来又被划掉，它也已删除；多次修改时，只取最后一个未被划掉且能看清的值。
- 红笔或其他颜色不天然代表最终值，判断依据始终是“旧值被划掉、旁边新值未被划掉”。
- 不得因为旧值更工整、更居中或仍然清晰，就忽略旁边较小、较乱的新写值。
- 同一格出现旧值、新值、红黑混写、覆盖或多组数字时，对应的 modified 必须为 true。
- 无法明确判断最后有效值时，ambiguity=true并说明候选；可以留空，不能假装确定。

逐行输出要求：
- train_number 和 track_name 填写最终有效值。
- old_train_number 和 old_track_name 填写能看清且已被划掉的旧值，没有则留空。
- train_modified 和 track_modified 表示该字段是否存在划掉、重写或覆盖。
- note 简短说明修改关系或不确定原因，例如“055被划掉，旁写044未划掉”；普通清晰行可留空。
- confidence 只表示对最终有效值的把握，存在明显修改时不得轻率给1.0。

只返回JSON对象，不要Markdown。每个表号必须返回一行且字段齐全：
{"rows":[{"table_no":${firstTable},"train_number":"","track_name":"","old_train_number":"","old_track_name":"","train_modified":false,"track_modified":false,"ambiguity":true,"note":"","confidence":0.0}]}

输出后复核车号范围、重复车号和重复股道。发现冲突时不要擅自替换，只降低置信度并在note中说明。

${memoryPrompt}`;
}

function getProvider(env, requested = '') {
  const wanted = String(requested || '').toLowerCase().trim();
  if (wanted === 'doubao') return 'doubao';
  if (wanted === 'gemini' || wanted === 'google') return 'gemini';
  if (wanted && wanted !== 'default') throw publicError('不支持的大模型选项。', 400);
  const explicit = String(env.MODEL_PROVIDER || '').toLowerCase().trim();
  if (explicit === 'doubao') return 'doubao';
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

async function callDoubao({ env, prompt, image, timeoutMs, debugTextOnly = false }) {
  if (!env.DOUBAO_API_KEY) throw publicError('豆包尚未配置：缺少 DOUBAO_API_KEY。', 503);
  const model = env.DOUBAO_MODEL || 'doubao-seed-2-1-pro-260628';
  const url = env.DOUBAO_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

  const content = debugTextOnly
    ? [{ type: 'text', text: '只返回 {"ok":true,"message":"debug"} 这个JSON对象。' }]
    : [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }];

  if (!debugTextOnly) splitDataUrl(image);

  const r = await withTimeout(signal => fetch(url, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${env.DOUBAO_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      // 车表识别是直接提取任务。Doubao Seed 2.1 默认开启深度思考，
      // 会显著增加首字延迟并容易触发 35 秒保护，因此这里明确关闭。
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }]
    })
  }), timeoutMs);

  const rawText = await r.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch {}

  if (!r.ok) {
    const detail = data?.error?.message || data?.message || rawText || `HTTP ${r.status}`;
    if (r.status === 401 || r.status === 403) throw publicError('豆包 API Key 无效或无权调用该模型，本次未计次数。', 502);
    if (r.status === 429) throw publicError('豆包请求过于频繁或额度受限，本次未计次数。', 429);
    if (r.status === 503) throw publicError('豆包当前繁忙，本次未计次数，请稍后重试。', 503);
    if (r.status >= 500) throw publicError(`豆包服务暂时不可用（${r.status}），本次未计次数。`, 503);
    throw publicError('豆包接口错误：' + String(detail).slice(0, 350) + '；本次未计次数。', 502);
  }

  let modelText = data?.choices?.[0]?.message?.content;
  if (Array.isArray(modelText)) modelText = modelText.map(x => typeof x === 'string' ? x : (x?.text || '')).join('');
  if (typeof modelText !== 'string') modelText = data?.output_text || data?.text;
  if (typeof modelText !== 'string') throw publicError('豆包没有返回可解析结果，本次未计次数。', 502);

  return { text: modelText, provider: 'doubao', model };
}

async function callModel(args) {
  const provider = getProvider(args.env, args.provider);
  if (provider === 'gemini') return await callGeminiOfficial(args);
  if (provider === 'doubao') return await callDoubao(args);
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

  // 只取少量高频案例，恢复人工纠错记忆，同时控制提示词长度与响应时间。
  const examples = await getCorrectionExamples(env.DB, 12);
  const prompt = buildPrompt(config, examples);
  const timeoutMs = Math.max(15000, Math.min(55000, num(env.MODEL_TIMEOUT_MS, 35000)));

  const started = Date.now();
  const provider = String(body.provider || 'default').toLowerCase().trim();
  const result = await callModel({ env, provider, prompt, image: body.image, timeoutMs });
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
  let provider = new URL(request.url).searchParams.get('provider') || 'default';
  if (request.method === 'POST') {
    try {
      const body = await request.clone().json();
      provider = String(body?.provider || provider);
    } catch {}
  }
  const timeoutMs = Math.max(8000, Math.min(30000, num(env.MODEL_TIMEOUT_MS, 15000)));
  const started = Date.now();
  const result = await callModel({ env, provider, prompt: '', image: '', timeoutMs, debugTextOnly: true });
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
