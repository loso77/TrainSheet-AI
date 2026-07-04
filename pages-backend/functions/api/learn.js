import { json, readJson, requireToken, rateLimit, ip, publicError } from '../_lib/shared.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) throw publicError('D1 数据库尚未绑定。', 503);
  const p = await requireToken(request, env);
  const ok = await rateLimit(env.DB, 'learn-device', p.sub, 6, 60);
  if (!ok) throw publicError('保存纠错过于频繁，请稍后再试。', 429);

  const body = await readJson(request, 96000);
  if (!Array.isArray(body.corrections)) throw publicError('纠错数据格式错误。', 400);
  const items = body.corrections.slice(0, 62);
  let saved = 0;

  for (const x of items) {
    const tableNo = Number(x.table_no);
    const fieldType = String(x.field_type || '');
    const original = String(x.original_value ?? '').trim().slice(0, 40);
    const corrected = String(x.corrected_value ?? '').trim().slice(0, 40);
    if (tableNo < 31 || tableNo > 61) continue;
    if (!['train_number','track_name'].includes(fieldType)) continue;
    if (original === corrected) continue;

    await env.DB.prepare(`
      INSERT INTO correction_memory
        (track, field_type, original_value, corrected_value, hit_count, updated_at)
      VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(track, field_type, original_value, corrected_value)
      DO UPDATE SET hit_count = hit_count + 1, updated_at = CURRENT_TIMESTAMP
    `).bind(tableNo, fieldType, original, corrected).run();

    try {
      await env.DB.prepare(`
        INSERT INTO recognition_feedback
          (table_no, field_type, model_value, old_value, corrected_value, modified, ambiguity, model_note, review_reasons)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        tableNo, fieldType, original, String(x.old_value ?? '').slice(0,40), corrected,
        x.modified ? 1 : 0, x.ambiguity ? 1 : 0,
        String(x.model_note ?? '').slice(0,300), JSON.stringify(Array.isArray(x.review_reasons)?x.review_reasons.slice(0,8):[])
      ).run();
    } catch (_) {
      // migration-v2.5.sql 尚未执行时仍保留原有纠错学习，不影响导出。
    }
    saved += 1;
  }

  const total = await env.DB.prepare(`SELECT COALESCE(SUM(hit_count),0) AS total FROM correction_memory`).first();
  return json({ saved, total: Number(total?.total || 0) });
}
