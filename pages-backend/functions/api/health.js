import { json } from '../_lib/shared.js';
export async function onRequestGet({ env }) {
  const doubaoBindings = Object.keys(env || {}).filter((name) => /DOUBAO/i.test(name));
  return json({
    ok: true,
    version: '2.6.1-doubao-binding-check',
    database: !!env.DB,
    model: env.OPENAI_MODEL || env.GEMINI_MODEL || 'default',
    providers: {
      gemini: !!(env.GEMINI_API_KEY || env.OPENAI_API_KEY),
      doubao: !!env.DOUBAO_API_KEY
    },
    doubao_model: env.DOUBAO_MODEL || 'doubao-seed-2-1-pro-260628',
    doubao_bindings: doubaoBindings
  });
}
