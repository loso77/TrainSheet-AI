import {
  json, readJson, requireToken, rateLimit, usageStatus, consumeDaily,
  ip, num, publicError
} from '../_lib/shared.js';
import {
  buildVehicleMapPrompt,
  parseVehicleMapModelText,
  vehicleHandwritingExamplesPrompt
} from '../../../vehicle-map-core.js';

function validateImage(image) {
  if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
    throw publicError('图片格式不受支持。', 400);
  }
}

function handwritingExamples(body) {
  const source = Array.isArray(body?.handwriting_examples) ? body.handwriting_examples.slice(0, 4) : [];
  return source.map(example => {
    const image = example?.image;
    validateImage(image);
    if (image.length > 240000) throw publicError('笔迹样本图片过大。', 413);
    const confirmed = String(example?.confirmed_value ?? '').trim().padStart(3, '0');
    if (!/^\d{3}$/.test(confirmed)) throw publicError('笔迹样本标注格式错误。', 400);
    return {
      image,
      confirmed_value: confirmed,
      original_value: String(example?.original_value ?? '').trim(),
      model_value: String(example?.model_value ?? '').trim()
    };
  });
}

function requestedProvider(env, requested) {
  const wanted = String(requested || '').toLowerCase().trim();
  if (wanted === 'doubao') return 'doubao';
  if (['qwen', 'alibaba', 'dashscope'].includes(wanted)) return 'qwen';
  if (wanted === 'openai') return 'openai';
  if (wanted && wanted !== 'default') throw publicError('不支持的大模型选项。', 400);
  const configured = String(env.MODEL_PROVIDER || '').toLowerCase().trim();
  if (configured === 'doubao' || configured === 'qwen' || configured === 'openai') return configured;
  if (env.DOUBAO_API_KEY) return 'doubao';
  if (env.QWEN_API_KEY) return 'qwen';
  return 'openai';
}

function qwenEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/compatible-mode\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/compatible-mode/v1/chat/completions`;
}

function providerConfig(env, provider) {
  if (provider === 'doubao') {
    if (!env.DOUBAO_API_KEY) throw publicError('豆包尚未配置：缺少 DOUBAO_API_KEY。', 503);
    return {
      key: env.DOUBAO_API_KEY,
      url: env.DOUBAO_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      model: env.DOUBAO_MODEL || 'doubao-seed-2-1-pro-260628',
      provider: 'doubao'
    };
  }
  if (provider === 'qwen') {
    if (!env.QWEN_API_KEY) throw publicError('千问尚未配置：缺少 QWEN_API_KEY。', 503);
    return {
      key: env.QWEN_API_KEY,
      url: qwenEndpoint(env.QWEN_API_BASE_URL),
      model: env.QWEN_MODEL || 'qwen3.7-plus',
      provider: 'qwen'
    };
  }
  if (!env.OPENAI_API_KEY) throw publicError('缺少 OPENAI_API_KEY。', 503);
  return {
    key: env.OPENAI_API_KEY,
    url: env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions',
    model: env.OPENAI_MODEL || 'gpt-4.1-mini',
    provider: 'openai-compatible'
  };
}

async function callModel(env, provider, images, examples, timeoutMs) {
  const config = providerConfig(env, provider);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('model-timeout'), timeoutMs);
  const content = [{ type: 'text', text: buildVehicleMapPrompt(images.length) }];
  const examplePrompt = vehicleHandwritingExamplesPrompt(examples);
  if (examplePrompt) {
    content.push({ type: 'text', text: examplePrompt });
    examples.forEach((example, index) => {
      content.push({ type: 'text', text: `人工确认笔迹示例${index + 1}：${example.confirmed_value}` });
      content.push({
        type: 'image_url',
        image_url: config.provider === 'openai-compatible'
          ? { url: example.image, detail: 'high' }
          : { url: example.image }
      });
    });
    content.push({ type: 'text', text: '以上仅为笔迹参考。下面才是本次需要逐张识别的完整运行计划照片，图片序号从1重新计算。' });
  }
  images.forEach(image => content.push({
    type: 'image_url',
    image_url: config.provider === 'openai-compatible' ? { url: image, detail: 'high' } : { url: image }
  }));
  const requestBody = {
    model: config.model,
    temperature: 0,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content }]
  };
  if (config.provider === 'doubao') requestBody.thinking = { type: 'disabled' };
  if (config.provider === 'qwen') requestBody.enable_thinking = false;

  let response;
  try {
    response = await fetch(config.url, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
  } catch (error) {
    if (error?.name === 'AbortError' || String(error).includes('model-timeout')) {
      throw publicError(`${images.length}张照片识别超过${Math.round(timeoutMs / 1000)}秒，本次未计次数。`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || raw || `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) throw publicError('大模型密钥无效或无权调用该模型，本次未计次数。', 502);
    if (response.status === 429) throw publicError('大模型请求过于频繁或额度受限，本次未计次数。', 429);
    if (response.status >= 500) throw publicError(`大模型服务暂时不可用（${response.status}），本次未计次数。`, 503);
    throw publicError('大模型接口错误：' + String(detail).slice(0, 350) + '；本次未计次数。', 502);
  }
  let text = data?.choices?.[0]?.message?.content;
  if (Array.isArray(text)) text = text.map(item => typeof item === 'string' ? item : (item?.text || '')).join('');
  if (typeof text !== 'string') text = data?.output_text || data?.text;
  if (typeof text !== 'string') throw publicError('大模型没有返回可解析结果，本次未计次数。', 502);
  return { text, provider: config.provider, model: config.model };
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) throw publicError('D1 数据库尚未绑定。', 503);
  const principal = await requireToken(request, env);
  const maxBytes = num(env.VEHICLE_MAP_MAX_REQUEST_BYTES, 24_000_000);
  const body = await readJson(request, maxBytes);
  if (!Array.isArray(body.images) || body.images.length < 1 || body.images.length > 3) {
    throw publicError('请一次提交1至3张运行计划照片。', 400);
  }
  body.images.forEach(validateImage);
  const examples = handwritingExamples(body);

  const [ipOk, deviceOk] = await Promise.all([
    rateLimit(env.DB, 'vehicle-map-ip', ip(request), 3, 60),
    rateLimit(env.DB, 'vehicle-map-device', principal.sub, 2, 60)
  ]);
  if (!ipOk || !deviceOk) throw publicError('车号识别请求过于频繁，请稍后再试。', 429);

  const deviceLimit = num(env.DEVICE_DAILY_LIMIT, 30);
  const globalLimit = num(env.GLOBAL_DAILY_LIMIT, 50);
  const before = await usageStatus(env.DB, principal.sub);
  if (before.global_used >= globalLimit) throw publicError('今日服务总额度已用完。', 429);
  if (before.device_used >= deviceLimit) throw publicError('这台设备今日识别次数已用完。', 429);

  const provider = requestedProvider(env, body.provider || 'default');
  const timeoutMs = Math.max(30000, Math.min(90000, num(env.VEHICLE_MAP_TIMEOUT_MS, 55000)));
  const started = Date.now();
  const modelResult = await callModel(env, provider, body.images, examples, timeoutMs);
  const normalized = parseVehicleMapModelText(modelResult.text, body.images.length);
  const usage = await consumeDaily(env.DB, principal.sub, deviceLimit, globalLimit);

  return json({
    ...normalized,
    model_provider: modelResult.provider,
    model_name: modelResult.model,
    elapsed_ms: Date.now() - started,
    model_timeout_ms: timeoutMs,
    usage: { ...usage, global_limit: globalLimit, device_limit: deviceLimit, expires_at: principal.exp }
  });
}
