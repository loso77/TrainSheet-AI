import { json } from '../_lib/shared.js';
export async function onRequestGet({ env }) {
  return json({ ok: true, version: '2.5.0-edit-aware', database: !!env.DB, model: env.OPENAI_MODEL || 'default' });
}
