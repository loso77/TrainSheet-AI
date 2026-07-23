import { json } from '../_lib/shared.js';
export async function onRequestGet({ env }) {
  return json({
    ok: true,
    version: '2.7.5-review-only',
    database: !!env.DB,
    model: env.QWEN_MODEL || 'qwen3.7-plus',
    providers: {
      qwen: !!env.QWEN_API_KEY,
      doubao: !!env.DOUBAO_API_KEY
    },
    qwen_model: env.QWEN_MODEL || 'qwen3.7-plus',
    doubao_model: env.DOUBAO_MODEL || 'doubao-seed-2-1-pro-260628'
  });
}
