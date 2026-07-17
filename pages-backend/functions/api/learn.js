import { json, readJson, requireToken, rateLimit, ip, publicError } from '../_lib/shared.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) throw publicError('D1 数据库尚未绑定。', 503);
  const p = await requireToken(request, env);
  const ok = await rateLimit(env.DB, 'learn-device', p.sub, 6, 60);
  if (!ok) throw publicError('保存纠错过于频繁，请稍后再试。', 429);

  const body = await readJson(request, 96000);
  if (!Array.isArray(body.corrections)) throw publicError('纠错数据格式错误。', 400);
  const items = body.corrections.slice(0, 200);
  let saved = 0;

  // 部分旧部署没有手动执行 migration-v2.5.3.sql。首次保存时自动补齐学习表，
  // 避免识别成功但“确认无误、保存学习”返回服务器处理失败。
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS correction_memory_dynamic (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_no INTEGER NOT NULL,
      field_type TEXT NOT NULL CHECK(field_type IN ('train_number','track_name')),
      original_value TEXT NOT NULL DEFAULT '',
      corrected_value TEXT NOT NULL DEFAULT '',
      hit_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(table_no,field_type,original_value,corrected_value)
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS recognition_feedback_dynamic (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_no INTEGER NOT NULL,
      field_type TEXT NOT NULL CHECK(field_type IN ('train_number','track_name')),
      model_value TEXT NOT NULL DEFAULT '',
      old_value TEXT NOT NULL DEFAULT '',
      corrected_value TEXT NOT NULL DEFAULT '',
      modified INTEGER NOT NULL DEFAULT 0,
      ambiguity INTEGER NOT NULL DEFAULT 0,
      model_note TEXT NOT NULL DEFAULT '',
      review_reasons TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  for (const x of items) {
    const tableNo = Number(x.table_no);
    const fieldType = String(x.field_type || '');
    const original = String(x.original_value ?? '').trim().slice(0, 40);
    const corrected = String(x.corrected_value ?? '').trim().slice(0, 40);
    if (!Number.isInteger(tableNo) || tableNo < 1 || tableNo > 9999) continue;
    if (!['train_number','track_name'].includes(fieldType)) continue;
    if (original === corrected) continue;

    await env.DB.prepare(`
      INSERT INTO correction_memory_dynamic
        (table_no, field_type, original_value, corrected_value, hit_count, updated_at)
      VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(table_no, field_type, original_value, corrected_value)
      DO UPDATE SET hit_count = hit_count + 1, updated_at = CURRENT_TIMESTAMP
    `).bind(tableNo, fieldType, original, corrected).run();

    try {
      await env.DB.prepare(`
        INSERT INTO recognition_feedback_dynamic
          (table_no, field_type, model_value, old_value, corrected_value, modified, ambiguity, model_note, review_reasons)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        tableNo, fieldType, original, String(x.old_value ?? '').slice(0,40), corrected,
        x.modified ? 1 : 0, x.ambiguity ? 1 : 0,
        String(x.model_note ?? '').slice(0,300), JSON.stringify(Array.isArray(x.review_reasons)?x.review_reasons.slice(0,8):[])
      ).run();
    } catch (_) {
      // migration-v2.5.3.sql 尚未执行时，学习保存会失败，但不影响识别；部署后应执行迁移。
    }
    saved += 1;
  }

  const total = await env.DB.prepare(`SELECT COALESCE(SUM(hit_count),0) AS total FROM correction_memory_dynamic`).first();
  return json({ saved, total: Number(total?.total || 0) });
}
