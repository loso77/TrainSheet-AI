import { debugModel } from './recognize.js';
export async function onRequestGet({ request, env }) {
  return await debugModel(request, env);
}
export async function onRequestPost({ request, env }) {
  return await debugModel(request, env);
}
