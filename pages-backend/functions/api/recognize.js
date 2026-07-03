import {
  json, readJson, requireToken, rateLimit, consumeDaily,
  ip, num, normalizeRows, publicError,
  getCorrectionExamples, correctionExamplesPrompt
} from '../_lib/shared.js';

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
  if (typeof body.image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(body.image)) {
    throw publicError('图片格式不受支持。', 400);
  }
  if (body.image.length > max) throw publicError('压缩后的图片过大。', 413);

  const note = typeof body.note === 'string' ? body.note.slice(0, 300) : '';
  const dl = num(env.DEVICE_DAILY_LIMIT, 30);
  const gl = num(env.GLOBAL_DAILY_LIMIT, 50);
  const used = await consumeDaily(env.DB, p.sub, dl, gl);

  const examples = await getCorrectionExamples(env.DB, 24);
  const memoryPrompt = correctionExamplesPrompt(examples);
  const prompt = `你是轨道交通车表识别助手。分析整张照片，即使照片倾斜也要根据印刷股道号、表格结构、相邻行和上下文匹配。
股道固定为31至61，共31行。
每行返回track整数、time、train_number、note、confidence。
time统一为HH:MM；train_number保持照片原样；看不清必须留空，不得猜测。
每个股道只能出现一次，必须包含31至61全部股道。

${memoryPrompt}

用户补充：${note || '无'}`;

  const r = await fetch(
    env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || 'gpt-4.1-mini',
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'train_sheet',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['rows'],
              properties: {
                rows: {
                  type: 'array', minItems: 31, maxItems: 31,
                  items: {
                    type: 'object', additionalProperties: false,
                    required: ['track','time','train_number','note','confidence'],
                    properties: {
                      track: { type: 'integer', minimum: 31, maximum: 61 },
                      time: { type: 'string' },
                      train_number: { type: 'string' },
                      note: { type: 'string' },
                      confidence: { type: 'number', minimum: 0, maximum: 1 }
                    }
                  }
                }
              }
            }
          }
        },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: body.image, detail: 'high' } }
          ]
        }]
      })
    }
  );

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw publicError(
      data?.error?.message ? '大模型接口错误：' + data.error.message : '大模型接口调用失败。',
      502
    );
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw publicError('大模型没有返回可解析结果。', 502);

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw publicError('大模型返回的 JSON 无效。', 502); }

  return json({
    rows: normalizeRows(parsed.rows),
    memory_examples_used: examples.length,
    usage: { ...used, global_limit: gl, device_limit: dl, expires_at: p.exp }
  });
}
