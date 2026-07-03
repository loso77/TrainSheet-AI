import { json, requireToken, usageStatus, num } from '../_lib/shared.js';

export async function onRequestGet({ request, env }) {
  const p = await requireToken(request, env);
  const u = await usageStatus(env.DB, p.sub);
  const memory = await env.DB.prepare(
    `SELECT COALESCE(SUM(occurrences),0) AS total FROM correction_memory`
  ).first();
  return json({
    ...u,
    device_limit: num(env.DEVICE_DAILY_LIMIT, 30),
    global_limit: num(env.GLOBAL_DAILY_LIMIT, 50),
    expires_at: p.exp,
    correction_memory_total: Number(memory?.total || 0)
  });
}
