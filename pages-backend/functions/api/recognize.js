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

  const dl = num(env.DEVICE_DAILY_LIMIT, 30);
  const gl = num(env.GLOBAL_DAILY_LIMIT, 50);
  const used = await consumeDaily(env.DB, p.sub, dl, gl);
  const examples = await getCorrectionExamples(env.DB, 32);
  const memoryPrompt = correctionExamplesPrompt(examples);

  const prompt = `你是轨道交通手写车表识别助手。任务不是只做OCR，而是判断每一行当前仍然有效的最终内容。

固定业务事实（只有这些可以作为硬规则）：
1. 最左侧印刷表号固定为31至61，每个表号恰好一行；表号不是股道。
2. 每个表号对应时间固定，服务器负责填写，你不要识别时间。
3. 车号只能是001至112的三位数字；同一张表内车号绝不重复。
4. 同一张表内股道绝不重复。
5. 表号右侧可能有一列只写1或2，这是无关列，必须忽略。
6. A代表东，C代表西；箭头不是股道内容。
7. 除上述事实外，不得假设某个表号固定对应某个车号或股道。车号和股道每天都会变化。

编辑动作语义（必须严格执行）：
- 被横线、斜线或明显涂抹划掉的内容，等同于“删除”，绝不能作为最终值。
- 在被删除内容旁边、上方或下方重新写的未划掉内容，等同于“新增”，应作为新的候选值。
- 若新增内容后来又被划掉，它也已删除；多次修改时，仅最后一个未被划掉且能看清的值有效。
- 红笔不天然等于正确，但红笔划掉旧值、并用红笔写出未划掉新值时，要理解为一次修改。
- 不得因为旧值更工整、更居中就忽略旁写新值。
- 同一格出现旧值、新值、红黑混写、覆盖或多组数字时，必须标记modified=true。
- 无法明确判断最后有效值时，必须ambiguity=true并说明候选，绝不可以假装确定。

逐行输出要求：
- train_number和track_name填写你判断的最终有效值；看不清可留空。
- old_train_number/old_track_name填写能看清且已被划掉的旧值，没有则留空。
- train_modified/track_modified表示该字段是否存在划掉、重写或覆盖。
- ambiguity表示最终值是否仍有实质不确定性。
- note必须简短说明修改关系或不确定原因，例如“055被划掉，旁写044未划掉”。普通清晰行可留空。
- confidence只反映你对“最终有效值”的把握，不是对旧值OCR的把握。存在明显修改时，即使看懂，也不得轻率给1.0。

识别完31行后，在内部复核：车号范围、重复车号、重复股道。发现冲突时不要擅自用缺失值替换，只降低置信度并在note中说明。

${memoryPrompt}`;

  const r = await fetch(env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-4.1-mini',
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'train_sheet_final_values', strict: true,
          schema: {
            type: 'object', additionalProperties: false, required: ['rows'],
            properties: { rows: {
              type: 'array', minItems: 31, maxItems: 31,
              items: {
                type: 'object', additionalProperties: false,
                required: ['table_no','train_number','track_name','old_train_number','old_track_name','train_modified','track_modified','ambiguity','note','confidence'],
                properties: {
                  table_no: { type: 'integer', minimum: 31, maximum: 61 },
                  train_number: { type: 'string' },
                  track_name: { type: 'string' },
                  old_train_number: { type: 'string' },
                  old_track_name: { type: 'string' },
                  train_modified: { type: 'boolean' },
                  track_modified: { type: 'boolean' },
                  ambiguity: { type: 'boolean' },
                  note: { type: 'string' },
                  confidence: { type: 'number', minimum: 0, maximum: 1 }
                }
              }
            }}
          }
        }
      },
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: body.image, detail: 'high' } }
      ]}]
    })
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw publicError(data?.error?.message ? '大模型接口错误：'+data.error.message : '大模型接口调用失败。', 502);
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw publicError('大模型没有返回可解析结果。', 502);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw publicError('大模型返回的 JSON 无效。', 502); }

  return json({
    rows: normalizeRows(parsed.rows),
    memory_examples_used: examples.length,
    usage: { ...used, global_limit: gl, device_limit: dl, expires_at: p.exp }
  });
}
