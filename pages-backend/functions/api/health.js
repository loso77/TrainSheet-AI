import { json } from '../_lib/shared.js';
export async function onRequestGet({ env }) {
  return json({
    ok: true,
    version: '2.7.1-batched-correction-review',
    database: !!env.DB,
    model: env.OPENAI_MODEL || env.GEMINI_MODEL || 'default',
    providers: {
      gemini: !!(env.GEMINI_API_KEY || env.OPENAI_API_KEY),
      doubao: !!env.DOUBAO_API_KEY
    },
    doubao_model: env.DOUBAO_MODEL || 'doubao-seed-2-1-pro-260628'
  });
}
