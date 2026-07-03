import{json}from'../_lib/shared.js';export async function onRequestGet({env}){return json({ok:!!(env.DB&&env.OPENAI_API_KEY&&env.DEVICE_ACCESS_CODE&&env.TOKEN_SECRET),version:'2.1.0-pages'})}
