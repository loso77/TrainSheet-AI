import {
  json, readJson, requireToken, rateLimit, getIp, publicError
} from "../_lib/shared.js";

export async function onRequestPost({ request, env }) {
  if (!env.DB) throw publicError("D1 数据库尚未绑定。", 503);
  const p = await requireToken(request, env);
  const ip = getIp(request);
  const ok = await rateLimit(env.DB, "learn-device", p.sub, 6, 60);
  if (!ok) throw publicError("保存纠错过于频繁，请稍后再试。", 429);

  const body = await readJson(request, 64_000);
  if (!Array.isArray(body.corrections)) throw publicError("纠错数据格式错误。", 400);
  const items = body.corrections.slice(0, 62);
  let saved = 0;

  for (const x of items) {
    const track = Number(x.track);
    const field = String(x.field || "");
    const predicted = String(x.predicted ?? "").trim().slice(0, 40);
    const corrected = String(x.corrected ?? "").trim().slice(0, 40);
    if (track < 31 || track > 61) continue;
    if (!['time','train_number'].includes(field)) continue;
    if (predicted === corrected) continue;

    await env.DB.prepare(`
      INSERT INTO correction_memory
        (track, field, predicted, corrected, occurrences, updated_at)
      VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(track, field, predicted, corrected)
      DO UPDATE SET
        occurrences = occurrences + 1,
        updated_at = CURRENT_TIMESTAMP
    `).bind(track, field, predicted, corrected).run();
    saved += 1;
  }

  const total = await env.DB.prepare(
    `SELECT COALESCE(SUM(occurrences),0) AS total FROM correction_memory`
  ).first();
  return json({ saved, total: Number(total?.total || 0) });
}
