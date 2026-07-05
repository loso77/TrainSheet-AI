import {
  json, readJson, requireToken, rateLimit, consumeDaily,
  ip, num, normalizeRows, parseSheetConfig, publicError,
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

  const config = parseSheetConfig(body.config);
  const dl = num(env.DEVICE_DAILY_LIMIT, 30);
  const gl = num(env.GLOBAL_DAILY_LIMIT, 50);
  const used = await consumeDaily(env.DB, p.sub, dl, gl);
  const examples = await getCorrectionExamples(env.DB, 32);
  const memoryPrompt = correctionExamplesPrompt(examples);

  const tableList=config.entries.map(x=>x.table_no).join('、');
  const firstTable=config.entries[0].table_no;
  const trainMin=String(config.train_number.min).padStart(3,'0'),trainMax=String(config.train_number.max).padStart(3,'0');
  const prompt = `你是轨道交通手写车表识别助手。任务不是只做OCR，而是判断每一行当前仍然有效的最终内容。

本次车表配置（只对本次请求生效）：
1. 需要识别的表号共${config.entries.length}个，依次为：${tableList}。表号不是股道。
2. 时间由服务器根据当前配置填写，你不要识别时间。
3. 车号有效范围是${trainMin}至${trainMax}；同一张表内车号绝不允许重复。
4. 永久硬规则：同一张表内车号和股道都绝不允许重复。
5. 表号右侧可能有一列只写1或2，这是无关列，必须忽略。
6. A代表东，C代表西；箭头不是股道内容。
7. 除上述规则外，不得假设某个表号固定对应某个车号或股道。

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
- note必须简短说明修改关系或不确定原因。普通清晰行可留空。
- confidence只反映你对最终有效值的把握。存在明显修改时不得轻率给1.0。

识别后复核车号范围、重复车号、重复股道。发现冲突时不要擅自用缺失值替换，只降低置信度并在note中说明。

只返回JSON对象，不要使用Markdown代码块。格式必须是：
{"rows":[{"table_no":${firstTable},"train_number":"","track_name":"","old_train_number":"","old_track_name":"","train_modified":false,"track_modified":false,"ambiguity":true,"note":"","confidence":0.0}]}
rows必须包含本次配置中的全部${config.entries.length}个表号，且每个字段都必须存在。

${memoryPrompt}`;

  const r = await fetch(env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-4.1-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [

        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: body.image, detail: 'high' } }
      ]}]
    })
  });

  const rawText = await r.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch {}
  if (!r.ok) {
    const detail = data?.error?.message || data?.message || rawText || `HTTP ${r.status}`;
    throw publicError('大模型接口错误：' + String(detail).slice(0, 500), 502);
  }
  let modelText = data?.choices?.[0]?.message?.content;
  if (Array.isArray(modelText)) {
    modelText = modelText.map(x => typeof x === 'string' ? x : (x?.text || '')).join('');
  }
  if (typeof modelText !== 'string') {
    modelText = data?.output_text || data?.text;
  }
  if (typeof modelText !== 'string') throw publicError('大模型没有返回可解析结果。', 502);
  modelText = modelText.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  let parsed;
  try { parsed = JSON.parse(modelText); } catch {
    throw publicError('大模型返回的 JSON 无效：' + modelText.slice(0, 240), 502);
  }

  return json({
    rows: normalizeRows(parsed.rows, config),
    config_used: config,
    memory_examples_used: examples.length,
    usage: { ...used, global_limit: gl, device_limit: dl, expires_at: p.exp }
  });
}
