import {
  json, readJson, requireToken, rateLimit, usageStatus, consumeDaily,
  ip, num, normalizeRows, parseSheetConfig, publicError,
  signToken, verifyToken, getCorrectionExamples, correctionExamplesPrompt
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

function buildPrompt(config, review = false, structuredRows = false) {
  const firstTable = config.entries[0].table_no;
  const trainMin = String(config.train_number.min).padStart(3, '0');
  const trainMax = String(config.train_number.max).padStart(3, '0');
  const outputFormat = structuredRows
    ? `只返回紧凑JSON，不要Markdown、字段名解释或备注。每个表号返回一个对象：
{"rows":[{"n":${firstTable},"c":"三位最终车号","g":"最终股道","cm":false,"gm":false,"a":false,"p":0.93}]}
n=表号，c=最终车号，g=最终股道，cm=车号有划改，gm=股道有划改，a=最终值不确定，p=置信度。`
    : `只返回紧凑JSON，不要Markdown、字段名解释或备注。每个表号返回一个七项数组：
[表号,最终车号,最终股道,车号有划改,股道有划改,最终值不确定,置信度]
例如：{"rows":[[${firstTable},"三位最终车号","最终股道",false,false,false,0.93]]}`;

  return `你是轨道交通手写车表${review ? '疑难行复核' : '识别'}助手。请直接读取照片，不做解释。

本次表号：${tableSpec(config.entries)}。
表号是每行的定位锚点。即使纸张弯折或表格线倾斜，也要从印刷表号所在行寻找其右侧的车号和股道。
只识别两项：车号、股道。不要识别时间，时间由系统填写。表号右侧的1或2是无关列，必须忽略。
车号范围：${trainMin}至${trainMax}。同一张表内车号不能重复，股道不能重复。
A=东，C=西，箭头不属于股道。
不要假设某个表号固定对应某个车号或股道。

修改规则必须执行：被横线、斜线、叉号或涂抹划掉的旧值无效；同一格旁边、上方或下方未划掉的手写新值才是最终值，不分红笔黑笔。多次修改只取最后一个未划掉值。不要因旧值更工整而选旧值。看不清最终值时留空并把ambiguity设为true，禁止猜测。

${outputFormat}
每个指定表号必须恰好出现一次。输出前检查范围和重复；冲突时保留看到的值、降低置信度并把不确定设为true。`;
}

function buildReviewPrompt(config, candidates, examples) {
  const firstTable = config.entries[0].table_no;
  const trainMin = String(config.train_number.min).padStart(3, '0');
  const trainMax = String(config.train_number.max).padStart(3, '0');
  const candidateLines = candidates.map(x => {
    const flags = [x.cm ? '车号疑似划改' : '', x.gm ? '股道疑似划改' : '', x.a ? '主模型不确定' : ''].filter(Boolean).join('、') || '规则校验异常';
    return `表号${x.n}：主模型车号=${x.c || '空'}，股道=${x.g || '空'}；${flags}`;
  }).join('\n');
  const memoryPrompt = correctionExamplesPrompt(examples);

  return `你是轨道交通手写车表的纠错复核助手。本次只复核${tableSpec(config.entries)}，忽略其他行，禁止重新抄整张表。

逐行按以下顺序核对：
1. 先找到印刷表号，再沿同一行向右找到车号和股道；表号右侧的1或2是无关列。
2. 列出格内所有可见候选；横线、斜线、叉号或涂抹覆盖的值是被删除的旧值。
3. 被划掉内容旁边、上方或下方最后一个未划掉的新写值才是最终值，不分红笔黑笔。
4. 主模型给出的值可能正是被划掉旧值，必须重新看图，不能直接照抄。
5. 车号范围${trainMin}至${trainMax}；A=东，C=西，箭头不属于股道。看不清就留空并将a设为true，禁止猜测。

主模型候选：
${candidateLines}

${memoryPrompt}
历史案例仅用于理解常见误读，图片证据优先，绝不能把表号与固定答案绑定。

只返回紧凑JSON，不要Markdown或解释：
{"rows":[{"n":${firstTable},"c":"最终未划掉的三位车号","g":"最终股道","oc":"能看清且已划掉的旧车号，否则空字符串","og":"能看清且已划掉的旧股道，否则空字符串","cm":true,"gm":false,"a":false,"p":0.93}]}
n=表号，c/g=最终车号/股道，oc/og=能看清且已被划掉的旧车号/旧股道，cm/gm=是否存在划掉重写，a=最终值不确定，p=置信度。每个指定表号必须恰好出现一次。`;
}

function compactBoolean(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

function expandCompactRows(input) {
  return (Array.isArray(input) ? input : []).map(row => {
    if (Array.isArray(row)) return {
      table_no: row[0], train_number: row[1], track_name: row[2],
      train_modified: compactBoolean(row[3]), track_modified: compactBoolean(row[4]),
      ambiguity: compactBoolean(row[5]), confidence: row[6],
      old_train_number: '', old_track_name: '', note: ''
    };
    if (row && typeof row === 'object' && ('n' in row || 'c' in row || 'g' in row)) return {
      table_no: row.n, train_number: row.c, track_name: row.g,
      train_modified: compactBoolean(row.cm), track_modified: compactBoolean(row.gm),
      ambiguity: compactBoolean(row.a), confidence: row.p,
      old_train_number: row.oc || '', old_track_name: row.og || '', note: ''
    };
    return row;
  });
}

async function imageFingerprint(image) {
  const bytes = new TextEncoder().encode(String(image || ''));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join('');
}

function providerConfigured(env, provider) {
  if (provider === 'doubao') return Boolean(env.DOUBAO_API_KEY);
  if (provider === 'qwen') return Boolean(env.QWEN_API_KEY);
  return Boolean(env.OPENAI_API_KEY);
}

function alternateProvider(provider) {
  return provider === 'doubao' ? 'qwen' : 'doubao';
}

function getProvider(env, requested = '') {
  const wanted = String(requested || '').toLowerCase().trim();
  if (wanted === 'doubao') return 'doubao';
  if (wanted === 'qwen' || wanted === 'alibaba' || wanted === 'dashscope') return 'qwen';
  // 兼容尚未刷新到新版的前端：旧的 Gemini 选项自动迁移为千问。
  if (wanted === 'gemini' || wanted === 'google') return 'qwen';
  if (wanted && wanted !== 'default') throw publicError('不支持的大模型选项。', 400);
  const explicit = String(env.MODEL_PROVIDER || '').toLowerCase().trim();
  if (explicit === 'doubao') return 'doubao';
  if (['qwen', 'alibaba', 'dashscope', 'gemini', 'google'].includes(explicit)) return 'qwen';
  if (explicit === 'openai') return 'openai';
  if (env.DOUBAO_API_KEY) return 'doubao';
  if (env.QWEN_API_KEY) return 'qwen';
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

function cleanJsonText(text) {
  return String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
}

function qwenEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/compatible-mode\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/compatible-mode/v1/chat/completions`;
}

async function callQwen({ env, prompt, image, timeoutMs, debugTextOnly = false }) {
  if (!env.QWEN_API_KEY) throw publicError('千问尚未配置：缺少 QWEN_API_KEY。', 503);
  const model = env.QWEN_MODEL || 'qwen3.7-plus';
  const url = qwenEndpoint(env.QWEN_API_BASE_URL);
  const content = debugTextOnly
    ? [{ type: 'text', text: '只返回 {"ok":true,"message":"debug"} 这个JSON对象。' }]
    : [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }];

  if (!debugTextOnly) splitDataUrl(image);

  const r = await withTimeout(signal => fetch(url, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${env.QWEN_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 2048,
      enable_thinking: false,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }]
    })
  }), timeoutMs);

  const rawText = await r.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch {}

  if (!r.ok) {
    const detail = data?.error?.message || data?.message || rawText || `HTTP ${r.status}`;
    if (r.status === 401 || r.status === 403) throw publicError('千问 API Key 无效或无权调用该模型，本次未计次数。', 502);
    if (r.status === 429) throw publicError('千问请求过于频繁或额度受限，本次未计次数。', 429);
    if (r.status === 503) throw publicError('千问当前繁忙，本次未计次数，请稍后重试。', 503);
    if (r.status >= 500) throw publicError(`千问服务暂时不可用（${r.status}），本次未计次数。`, 503);
    throw publicError('千问接口错误：' + String(detail).slice(0, 350) + '；本次未计次数。', 502);
  }

  let modelText = data?.choices?.[0]?.message?.content;
  if (Array.isArray(modelText)) modelText = modelText.map(x => typeof x === 'string' ? x : (x?.text || '')).join('');
  if (typeof modelText !== 'string') modelText = data?.output_text || data?.text;
  if (typeof modelText !== 'string') throw publicError('千问没有返回可解析结果，本次未计次数。', 502);

  return { text: modelText, provider: 'qwen', model };
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
      max_tokens: 2048,
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
      max_tokens: 2048,
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
  if (provider === 'qwen') return await callQwen(args);
  if (provider === 'doubao') return await callDoubao(args);
  return await callOpenAICompatible(args);
}

function parseModelRows(resultText, config) {
  const modelText = cleanJsonText(resultText);
  let parsed;
  try { parsed = JSON.parse(modelText); } catch {
    throw publicError('大模型返回结果不完整或格式无效，本次未计次数。', 502);
  }
  return normalizeRows(expandCompactRows(parsed.rows), config);
}

function reviewPriority(row) {
  let score = (1 - row.confidence) * 30;
  if (!row.train_number || !row.track_name) score += 120;
  if (row.ambiguity) score += 100;
  if (row.train_modified || row.track_modified) score += 90;
  if ((row.review_reasons || []).some(x => x.includes('重复'))) score += 70;
  return score;
}

function isSubsetNumbers(requested, permitted) {
  const allowed = new Set(permitted);
  return requested.length > 0 && requested.every(x => allowed.has(x));
}

function relevantCorrectionExamples(examples, candidates, limit = 4) {
  const trainValues = new Set(candidates.map(x => String(x.c || '')).filter(Boolean));
  const trackValues = new Set(candidates.map(x => String(x.g || '')).filter(Boolean));
  return (examples || []).filter(x => {
    const original = String(x.original_value || '');
    return x.field_type === 'track_name' ? trackValues.has(original) : trainValues.has(original);
  }).slice(0, limit);
}

async function handleReview({ request, env, principal, body, max }) {
  const [ipOk, deviceOk] = await Promise.all([
    rateLimit(env.DB, 'review-ip', ip(request), 6, 60),
    rateLimit(env.DB, 'review-device', principal.sub, 3, 60)
  ]);
  if (!ipOk || !deviceOk) throw publicError('自动复核请求过于频繁，请稍后再试。', 429);

  splitDataUrl(body.image);
  if (body.image.length > max) throw publicError('压缩后的图片过大。', 413);
  const token = await verifyToken(body.review_token, env.TOKEN_SECRET);
  const now = Math.floor(Date.now() / 1000);
  if (!token || token.scope !== 'review' || token.sub !== principal.sub || token.exp < now ||
      token.ver !== String(env.TOKEN_VERSION || '1')) {
    throw publicError('自动复核凭证无效或已过期，请重新识别。', 401);
  }

  const provider = String(body.provider || '').toLowerCase().trim();
  if (provider !== token.reviewer) throw publicError('自动复核模型与凭证不匹配。', 400);
  const fingerprint = await imageFingerprint(body.image);
  if (fingerprint !== token.image_hash) throw publicError('自动复核照片与首次识别不一致。', 400);

  const config = parseSheetConfig(body.config);
  const requested = config.entries.map(x => x.table_no).sort((a, b) => a - b);
  const permitted = (Array.isArray(token.table_nos) ? token.table_nos : []).map(Number).sort((a, b) => a - b);
  if (!isSubsetNumbers(requested, permitted)) {
    throw publicError('自动复核表号范围与凭证不匹配。', 400);
  }

  const candidates = (Array.isArray(token.candidates) ? token.candidates : []).filter(x => requested.includes(Number(x.n)));
  if (candidates.length !== requested.length) throw publicError('自动复核缺少主模型候选。', 400);
  const memory = relevantCorrectionExamples(await getCorrectionExamples(env.DB, 20), candidates);
  const timeoutMs = Math.max(12000, Math.min(24000, num(env.REVIEW_TIMEOUT_MS, 22000)));
  const started = Date.now();
  const result = await callModel({
    env,
    provider,
    prompt: buildReviewPrompt(config, candidates, memory),
    image: body.image,
    timeoutMs,
    reviewMode: true
  });
  const rows = parseModelRows(result.text, config);
  const usage = await usageStatus(env.DB, principal.sub);
  return json({
    rows,
    review: true,
    counted: false,
    model_provider: result.provider,
    model_name: result.model,
    elapsed_ms: Date.now() - started,
    model_timeout_ms: timeoutMs,
    usage: {
      ...usage,
      global_limit: num(env.GLOBAL_DAILY_LIMIT, 50),
      device_limit: num(env.DEVICE_DAILY_LIMIT, 30),
      expires_at: principal.exp
    }
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) throw publicError('D1 数据库尚未绑定。', 503);
  const p = await requireToken(request, env);
  const max = num(env.MAX_REQUEST_BYTES, 9000000);
  const body = await readJson(request, max);

  if (String(body.mode || '').toLowerCase() === 'review') {
    return await handleReview({ request, env, principal: p, body, max });
  }

  const [ipOk, deviceOk] = await Promise.all([
    rateLimit(env.DB, 'recognize-ip', ip(request), 4, 60),
    rateLimit(env.DB, 'recognize-device', p.sub, 3, 60)
  ]);
  if (!ipOk || !deviceOk) throw publicError('请求过于频繁，请稍后再试。', 429);

  splitDataUrl(body.image);
  if (body.image.length > max) throw publicError('压缩后的图片过大。', 413);

  const config = parseSheetConfig(body.config);
  const dl = num(env.DEVICE_DAILY_LIMIT, 30);
  const gl = num(env.GLOBAL_DAILY_LIMIT, 50);
  const requestedReviewImageHash = String(body.review_image_hash || '').trim().toLowerCase();
  if (requestedReviewImageHash && !/^[a-f0-9]{24}$/.test(requestedReviewImageHash)) {
    throw publicError('高清复核照片校验值无效。', 400);
  }

  const beforeUsage = await usageStatus(env.DB, p.sub);
  if (beforeUsage.global_used >= gl) throw publicError('今日服务总额度已用完。', 429);
  if (beforeUsage.device_used >= dl) throw publicError('这台设备今日识别次数已用完。', 429);

  const provider = String(body.provider || 'default').toLowerCase().trim();
  const primaryProvider = getProvider(env, provider);
  if (primaryProvider === 'qwen') {
    throw publicError('千问现仅用于疑难行复核，请使用智能识别或快速识别。', 400);
  }
  const prompt = buildPrompt(config, false, primaryProvider === 'qwen');
  const timeoutMs = Math.max(15000, Math.min(55000, num(env.MODEL_TIMEOUT_MS, 35000)));

  const started = Date.now();
  const result = await callModel({ env, provider, prompt, image: body.image, timeoutMs });
  const elapsed_ms = Date.now() - started;
  const normalizedRows = parseModelRows(result.text, config);

  const used = await consumeDaily(env.DB, p.sub, dl, gl);
  const reviewer = alternateProvider(primaryProvider);
  const flagged = normalizedRows.filter(x => x.needs_review).sort((a, b) => reviewPriority(b) - reviewPriority(a));
  const reviewRows = providerConfigured(env, reviewer) ? flagged.slice(0, 9) : [];
  let review = null;
  if (reviewRows.length) {
    const tableNos = reviewRows.map(x => x.table_no);
    review = {
      provider: reviewer,
      table_nos: tableNos,
      total_flagged: flagged.length,
      batch_size: 3,
      token: await signToken({
        scope: 'review', sub: p.sub, reviewer, table_nos: tableNos,
        candidates: reviewRows.map(x => ({
          n: x.table_no, c: x.train_number, g: x.track_name,
          cm: x.train_modified, gm: x.track_modified, a: x.ambiguity
        })),
        image_hash: requestedReviewImageHash || await imageFingerprint(body.image),
        ver: String(env.TOKEN_VERSION || '1'),
        exp: Math.floor(Date.now() / 1000) + 600
      }, env.TOKEN_SECRET)
    };
  }

  return json({
    rows: normalizedRows,
    config_used: config,
    memory_examples_used: 0,
    model_provider: result.provider,
    model_name: result.model,
    elapsed_ms,
    model_timeout_ms: timeoutMs,
    review,
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
