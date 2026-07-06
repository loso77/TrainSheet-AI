import {
  json, readJson, requireToken, rateLimit, usageStatus, consumeDaily,
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

  // 只检查额度，不在调用模型前扣次数。
  const beforeUsage = await usageStatus(env.DB, p.sub);
  if (beforeUsage.global_used >= gl) throw publicError('今日服务总额度已用完。', 429);
  if (beforeUsage.device_used >= dl) throw publicError('这台设备今日识别次数已用完。', 429);

  // 减少历史案例数量，降低提示词体积和模型处理压力。
  const examples = await getCorrectionExamples(env.DB, 12);
  const memoryPrompt = correctionExamplesPrompt(examples);

  const tableNumbers=config.entries.map(x=>x.table_no);
  const isContinuous=tableNumbers.every((n,i)=>i===0||n===tableNumbers[i-1]+1);
  const tableSpec=isContinuous
    ? `${tableNumbers[0]}至${tableNumbers[tableNumbers.length-1]}（共${tableNumbers.length}个）`
    : `${tableNumbers.join('、')}（共${tableNumbers.length}个）`;
  const firstTable=config.entries[0].table_no;
  const trainMin=String(config.train_number.min).padStart(3,'0'),trainMax=String(config.train_number.max).padStart(3,'0');
  const prompt = `你是轨道交通手写车表识别助手。请识别本次配置中的车号和股道，并判断涂改后的最终有效值。

本次表号：${tableSpec}。表号不是股道；时间由服务器填写，不要识别时间。
车号范围：${trainMin}至${trainMax}。同一张表内车号、股道都绝不允许重复。
表号右侧可能有无关的1或2列，必须忽略。A=东，C=西，箭头不属于股道。
不得假设某个表号固定对应某个车号或股道。

涂改规则：
- 被横线、斜线或明显涂抹划掉的内容等同删除，不能作为最终值。
- 旁边、上方或下方新写且未被划掉的内容是新增候选。
- 多次修改时，只取最后一个未被划掉且能看清的值。
- 同格出现旧值、新值、覆盖或红黑混写时，对应modified=true。
- 无法确定最终值时，ambiguity=true，可留空，不能假装确定。

只返回JSON对象，不要Markdown。每个表号必须返回一行，字段必须齐全：
{"rows":[{"table_no":${firstTable},"train_number":"","track_name":"","old_train_number":"","old_track_name":"","train_modified":false,"track_modified":false,"ambiguity":true,"note":"","confidence":0.0}]}

输出后检查：车号范围、重复车号、重复股道。发现冲突只降低置信度并说明，不要擅自替换。

${memoryPrompt}`;

  const timeoutMs = Math.max(15000, Math.min(50000, num(env.MODEL_TIMEOUT_MS, 35000)));
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('model-timeout'), timeoutMs);

  let r;
  try {
    r = await fetch(env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
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
  } catch (error) {
    if (error?.name === 'AbortError' || String(error).includes('model-timeout')) {
      throw publicError(`大模型响应超过${Math.round(timeoutMs/1000)}秒，本次未计次数，请稍后重试。`, 504);
    }
    throw publicError('连接大模型失败，本次未计次数。', 502);
  } finally {
    clearTimeout(timeoutId);
  }

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

  const normalizedRows = normalizeRows(parsed.rows, config);

  // 只有成功获得并解析结果后才计数。
  const used = await consumeDaily(env.DB, p.sub, dl, gl);

  return json({
    rows: normalizedRows,
    config_used: config,
    memory_examples_used: examples.length,
    model_timeout_ms: timeoutMs,
    usage: { ...used, global_limit: gl, device_limit: dl, expires_at: p.exp }
  });
}
