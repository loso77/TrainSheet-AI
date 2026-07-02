const enc = new TextEncoder();
const dec = new TextDecoder();

export class UsageGate {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const body = await request.json();
    const today = new Date().toISOString().slice(0, 10);
    if (pathname === "/consume") {
      const { device_id, device_limit, global_limit } = body;
      const storedDay = await this.state.storage.get("day");
      if (storedDay !== today) {
        await this.state.storage.put({ day: today, global: 0, devices: {} });
      }
      let global = (await this.state.storage.get("global")) || 0;
      let devices = (await this.state.storage.get("devices")) || {};
      const used = devices[device_id] || 0;
      if (global >= global_limit) return json({ ok:false, error:"今日服务总额度已用完。", global_used:global, device_used:used }, 429);
      if (used >= device_limit) return json({ ok:false, error:"这台设备今日识别次数已用完。", global_used:global, device_used:used }, 429);
      global += 1; devices[device_id] = used + 1;
      await this.state.storage.put({ global, devices });
      return json({ ok:true, global_used:global, device_used:used+1 });
    }
    if (pathname === "/status") {
      const storedDay = await this.state.storage.get("day");
      if (storedDay !== today) return json({global_used:0,device_used:0});
      const global = (await this.state.storage.get("global")) || 0;
      const devices = (await this.state.storage.get("devices")) || {};
      return json({global_used:global,device_used:devices[body.device_id]||0});
    }
    return json({error:"Not found"},404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") return new Response(null, { status:204, headers:cors });
    if (origin && !isAllowedOrigin(origin, env.ALLOWED_ORIGIN)) return json({error:"来源不被允许。"},403,cors);
    if (request.method !== "GET" && request.method !== "POST") return json({error:"Method not allowed"},405,cors);

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ok:!!(env.OPENAI_API_KEY&&env.DEVICE_ACCESS_CODE&&env.TOKEN_SECRET),version:"2.0.0"},200,cors);
      }
      if (url.pathname === "/auth" && request.method === "POST") return await auth(request,env,cors);
      if (url.pathname === "/me" && request.method === "GET") return await me(request,env,cors);
      if (url.pathname === "/recognize" && request.method === "POST") return await recognize(request,env,cors);
      return json({error:"Not found"},404,cors);
    } catch (e) {
      // 不记录请求体、照片、令牌或密钥。
      return json({error:e?.publicMessage||"服务器处理失败。"},e?.status||500,cors);
    }
  }
};

async function auth(request, env, cors) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const allowed = await env.AUTH_RATE.limit({ key: ip });
  if (!allowed.success) return json({error:"尝试次数过多，请稍后再试。"},429,cors);
  const body = await readJsonLimited(request, 4096);
  if (typeof body.code !== "string" || body.code.length < 8 || body.code.length > 128) return json({error:"授权码格式不正确。"},400,cors);
  if (!(await timingSafeEqual(body.code, env.DEVICE_ACCESS_CODE))) return json({error:"设备授权码错误。"},401,cors);
  const deviceId = crypto.randomUUID();
  const exp = Math.floor(Date.now()/1000) + num(env.TOKEN_TTL_DAYS,30)*86400;
  const payload = {sub:deviceId,exp,ver:String(env.TOKEN_VERSION||"1"),scope:"recognize"};
  const token = await signToken(payload, env.TOKEN_SECRET);
  const usage = await usageStatus(env, deviceId);
  return json({token,expires_at:exp,...usage,device_limit:num(env.DEVICE_DAILY_LIMIT,30),global_limit:num(env.GLOBAL_DAILY_LIMIT,50)},200,cors);
}

async function me(request, env, cors) {
  const p = await requireToken(request,env);
  const usage = await usageStatus(env,p.sub);
  return json({...usage,device_limit:num(env.DEVICE_DAILY_LIMIT,30),global_limit:num(env.GLOBAL_DAILY_LIMIT,50),expires_at:p.exp},200,cors);
}

async function recognize(request, env, cors) {
  const p = await requireToken(request,env);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const [ipRate, deviceRate] = await Promise.all([
    env.RECOGNIZE_IP_RATE.limit({key:ip}),
    env.RECOGNIZE_DEVICE_RATE.limit({key:p.sub})
  ]);
  if (!ipRate.success || !deviceRate.success) return json({error:"请求过于频繁，请稍后再试。"},429,cors);

  const len = Number(request.headers.get("Content-Length")||0);
  const maxBytes = num(env.MAX_REQUEST_BYTES,9_000_000);
  if (len && len > maxBytes) return json({error:"照片请求过大。"},413,cors);
  const body = await readJsonLimited(request,maxBytes);
  if (typeof body.image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(body.image)) return json({error:"图片格式不受支持。"},400,cors);
  if (body.image.length > maxBytes) return json({error:"压缩后的图片过大。"},413,cors);
  const note = typeof body.note==="string" ? body.note.slice(0,300) : "";

  const gate = env.USAGE_GATE.get(env.USAGE_GATE.idFromName("global"));
  const consumedResp = await gate.fetch("https://gate/consume",{method:"POST",body:JSON.stringify({
    device_id:p.sub,device_limit:num(env.DEVICE_DAILY_LIMIT,30),global_limit:num(env.GLOBAL_DAILY_LIMIT,50)
  })});
  const consumed = await consumedResp.json();
  if (!consumed.ok) return json({error:consumed.error},429,cors);

  const prompt = `你是轨道交通车表识别助手。分析整张照片，即使照片倾斜也要根据印刷股道号、表格结构、相邻行和上下文匹配。
股道固定为31至61，共31行。
每行返回：track整数；time统一为HH:MM，看不清则空；train_number保持原样，看不清则空；note记录模糊/遮挡/疑似跨行；confidence为0到1。
不得猜测。每个股道只能一次。必须包含31至61全部股道，空白行也返回。
只输出符合JSON Schema的结果。用户补充：${note||"无"}`;

  const upstream = await fetch(env.OPENAI_API_URL||"https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{"Authorization":`Bearer ${env.OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({
      model:env.OPENAI_MODEL||"gpt-4.1-mini",
      temperature:0,
      response_format:{type:"json_schema",json_schema:{
        name:"train_sheet",strict:true,schema:{
          type:"object",additionalProperties:false,required:["rows"],properties:{rows:{
            type:"array",minItems:31,maxItems:31,items:{
              type:"object",additionalProperties:false,required:["track","time","train_number","note","confidence"],
              properties:{track:{type:"integer",minimum:31,maximum:61},time:{type:"string"},train_number:{type:"string"},note:{type:"string"},confidence:{type:"number",minimum:0,maximum:1}}
            }
          }}
        }
      }},
      messages:[{role:"user",content:[{type:"text",text:prompt},{type:"image_url",image_url:{url:body.image,detail:"high"}}]}]
    })
  });
  const data = await upstream.json().catch(()=>({}));
  if (!upstream.ok) {
    const e=new Error();e.status=502;e.publicMessage=data?.error?.message?"大模型接口错误："+data.error.message:"大模型接口调用失败。";throw e;
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text!=="string") { const e=new Error();e.status=502;e.publicMessage="大模型没有返回可解析结果。";throw e; }
  let parsed; try{parsed=JSON.parse(text)}catch{const e=new Error();e.status=502;e.publicMessage="大模型返回的JSON无效。";throw e}
  return json({rows:normalizeRows(parsed.rows),usage:{
    global_used:consumed.global_used,device_used:consumed.device_used,
    global_limit:num(env.GLOBAL_DAILY_LIMIT,50),device_limit:num(env.DEVICE_DAILY_LIMIT,30),expires_at:p.exp
  }},200,cors);
}

function normalizeRows(input){
  const map=new Map();
  for(const x of Array.isArray(input)?input:[]){
    const t=Number(x.track);if(t<31||t>61||map.has(t))continue;
    map.set(t,{track:t,time:String(x.time||"").trim(),train_number:String(x.train_number||"").trim(),note:String(x.note||"").trim(),confidence:Math.max(0,Math.min(1,Number(x.confidence)||0))});
  }
  return Array.from({length:31},(_,i)=>map.get(i+31)||{track:i+31,time:"",train_number:"",note:"模型未返回该股道",confidence:0});
}

async function requireToken(request,env){
  const h=request.headers.get("Authorization")||"";
  if(!h.startsWith("Bearer ")){const e=new Error();e.status=401;e.publicMessage="设备尚未授权。";throw e}
  const p=await verifyToken(h.slice(7),env.TOKEN_SECRET);
  if(!p||p.exp<Math.floor(Date.now()/1000)||p.ver!==String(env.TOKEN_VERSION||"1")||p.scope!=="recognize"){
    const e=new Error();e.status=401;e.publicMessage="设备授权已过期或已撤销。";throw e
  }
  return p;
}
async function usageStatus(env,deviceId){
  const gate=env.USAGE_GATE.get(env.USAGE_GATE.idFromName("global"));
  const r=await gate.fetch("https://gate/status",{method:"POST",body:JSON.stringify({device_id:deviceId})});
  return await r.json();
}
async function signToken(payload,secret){
  const head=b64url(JSON.stringify({alg:"HS256",typ:"JWT"})),body=b64url(JSON.stringify(payload)),msg=`${head}.${body}`;
  const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("HMAC",key,enc.encode(msg));
  return `${msg}.${bytesB64url(new Uint8Array(sig))}`;
}
async function verifyToken(token,secret){
  const parts=token.split(".");if(parts.length!==3)return null;
  const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  const ok=await crypto.subtle.verify("HMAC",key,b64urlBytes(parts[2]),enc.encode(parts[0]+"."+parts[1]));
  if(!ok)return null;try{return JSON.parse(dec.decode(b64urlBytes(parts[1])))}catch{return null}
}
async function timingSafeEqual(a,b){
  const ha=new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(a)));
  const hb=new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(b)));
  let d=0;for(let i=0;i<ha.length;i++)d|=ha[i]^hb[i];return d===0;
}
async function readJsonLimited(request,max){
  const buf=await request.arrayBuffer();if(buf.byteLength>max){const e=new Error();e.status=413;e.publicMessage="请求过大。";throw e}
  try{return JSON.parse(dec.decode(buf))}catch{const e=new Error();e.status=400;e.publicMessage="请求格式错误。";throw e}
}
function corsHeaders(origin,allowed){const h={"Vary":"Origin","Access-Control-Allow-Headers":"Authorization, Content-Type","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Max-Age":"86400","Cache-Control":"no-store"};if(origin&&isAllowedOrigin(origin,allowed))h["Access-Control-Allow-Origin"]=origin;return h}
function isAllowedOrigin(origin,list){return String(list||"").split(",").map(x=>x.trim()).filter(Boolean).includes(origin)}
function json(data,status=200,extra={}){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json;charset=utf-8","Cache-Control":"no-store",...extra}})}
function num(x,d){const n=Number(x);return Number.isFinite(n)?n:d}
function b64url(s){return bytesB64url(enc.encode(s))}
function bytesB64url(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}
function b64urlBytes(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";const b=atob(s),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
