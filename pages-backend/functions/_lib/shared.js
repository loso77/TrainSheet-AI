const enc=new TextEncoder(),dec=new TextDecoder();
export function json(data,status=200,extra={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store',...extra}})}
export function corsHeaders(request,env){const origin=request.headers.get('Origin')||'',allowed=String(env.ALLOWED_ORIGIN||'').split(',').map(x=>x.trim()).filter(Boolean),ok=!origin||allowed.includes(origin),h={'Vary':'Origin','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Max-Age':'86400'};if(origin&&ok)h['Access-Control-Allow-Origin']=origin;return {h,ok}}
export function publicError(message,status=400){const e=new Error(message);e.publicMessage=message;e.status=status;return e}
export async function readJson(request,max=9000000){const b=await request.arrayBuffer();if(b.byteLength>max)throw publicError('请求过大。',413);try{return JSON.parse(dec.decode(b))}catch{throw publicError('请求格式错误。',400)}}
export function num(v,d){const n=Number(v);return Number.isFinite(n)?n:d}
export async function timingSafeEqual(a,b){const [x,y]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(String(a))),crypto.subtle.digest('SHA-256',enc.encode(String(b)))]);const aa=new Uint8Array(x),bb=new Uint8Array(y);let z=0;for(let i=0;i<aa.length;i++)z|=aa[i]^bb[i];return z===0}
function b64u(bytes){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function unb64(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const b=atob(s),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
export async function signToken(p,secret){const h=b64u(enc.encode(JSON.stringify({alg:'HS256',typ:'JWT'}))),b=b64u(enc.encode(JSON.stringify(p))),m=h+'.'+b,k=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']),s=await crypto.subtle.sign('HMAC',k,enc.encode(m));return m+'.'+b64u(new Uint8Array(s))}
export async function verifyToken(t,secret){const p=String(t||'').split('.');if(p.length!==3)return null;const k=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);if(!await crypto.subtle.verify('HMAC',k,unb64(p[2]),enc.encode(p[0]+'.'+p[1])))return null;try{return JSON.parse(dec.decode(unb64(p[1])))}catch{return null}}
export async function requireToken(request,env){const h=request.headers.get('Authorization')||'';if(!h.startsWith('Bearer '))throw publicError('设备尚未授权。',401);const p=await verifyToken(h.slice(7),env.TOKEN_SECRET),now=Math.floor(Date.now()/1000);if(!p||p.exp<now||p.ver!==String(env.TOKEN_VERSION||'1')||p.scope!=='recognize')throw publicError('设备授权已过期或已撤销。',401);return p}
export function ip(request){return request.headers.get('CF-Connecting-IP')||'unknown'}
export async function rateLimit(db,bucket,key,limit,seconds){const now=Math.floor(Date.now()/1000),w=Math.floor(now/seconds)*seconds,r=await db.prepare(`INSERT INTO rate_limits(bucket,key_value,window_start,count) VALUES(?,?,?,1) ON CONFLICT(bucket,key_value,window_start) DO UPDATE SET count=count+1 WHERE count<? RETURNING count`).bind(bucket,key,w,limit).first();return !!r}
export async function usageStatus(db,id){const day=new Date().toISOString().slice(0,10),r=await db.prepare(`SELECT subject,count FROM daily_usage WHERE day=? AND subject IN('__global__',?)`).bind(day,id).all();let global_used=0,device_used=0;for(const x of r.results||[]){if(x.subject==='__global__')global_used=x.count;else device_used=x.count}return{global_used,device_used}}
export async function consumeDaily(db,id,dl,gl){const day=new Date().toISOString().slice(0,10),g=await db.prepare(`INSERT INTO daily_usage(day,subject,count) VALUES(?,'__global__',1) ON CONFLICT(day,subject) DO UPDATE SET count=count+1 WHERE count<? RETURNING count`).bind(day,gl).first();if(!g)throw publicError('今日服务总额度已用完。',429);const d=await db.prepare(`INSERT INTO daily_usage(day,subject,count) VALUES(?,?,1) ON CONFLICT(day,subject) DO UPDATE SET count=count+1 WHERE count<? RETURNING count`).bind(day,id,dl).first();if(!d){await db.prepare(`UPDATE daily_usage SET count=MAX(count-1,0) WHERE day=? AND subject='__global__'`).bind(day).run();throw publicError('这台设备今日识别次数已用完。',429)}return{global_used:g.count,device_used:d.count}}
export const FIXED_TIMES = [
  '4:21','4:46','4:50','4:52','5:00','5:08','5:10','5:16','5:18','5:38',
  '5:47','5:51','5:55','5:59','6:05','6:09','6:13','6:19','6:23','6:27',
  '6:31','6:35','6:39','6:43','6:47','6:51','6:55','7:00','7:05','7:17','7:35'
];

export function normalizeTrackName(value){
  let s=String(value??'').trim().toUpperCase();
  s=s.replace(/[→➡➜➝]/g,'').replace(/-?>/g,'').replace(/\s+/g,'');
  s=s.replace(/[，。,.；;:：]/g,'');
  const chinese=s.match(/^(\d{1,2})(东|西)$/);
  if(chinese)return chinese[1]+chinese[2];
  const code=s.match(/^(\d{1,2})(A|C)$/);
  if(code)return code[1]+(code[2]==='A'?'东':'西');
  return s;
}

export function normalizeRows(input){
  const m=new Map();
  for(const x of Array.isArray(input)?input:[]){
    const tableNo=Number(x.table_no);
    if(tableNo<31||tableNo>61||m.has(tableNo))continue;
    const idx=tableNo-31;
    m.set(tableNo,{
      table_no:tableNo,
      time:FIXED_TIMES[idx],
      train_number:String(x.train_number??'').trim(),
      track_name:normalizeTrackName(x.track_name),
      note:String(x.note??'').trim(),
      confidence:Math.max(0,Math.min(1,Number(x.confidence)||0))
    });
  }
  return Array.from({length:31},(_,i)=>m.get(i+31)||{
    table_no:i+31,time:FIXED_TIMES[i],train_number:'',track_name:'',
    note:'模型未返回该表号',confidence:0
  });
}

export async function getCorrectionExamples(db, limit = 24) {
  const result = await db.prepare(`
    SELECT track, field_type, original_value, corrected_value, hit_count
    FROM correction_memory
    WHERE original_value <> corrected_value
      AND field_type IN ('train_number','track_name')
    ORDER BY hit_count DESC, updated_at DESC
    LIMIT ?
  `).bind(limit).all();
  return result.results || [];
}

export function correctionExamplesPrompt(examples) {
  if (!examples?.length) return '暂无历史人工纠错案例。';
  const lines = examples.map(x => {
    const label = x.field_type === 'track_name' ? '股道' : '车号';
    const before = x.original_value === '' ? '（空）' : x.original_value;
    const after = x.corrected_value === '' ? '（空）' : x.corrected_value;
    return `表号${x.track} ${label}: ${before} → ${after}（已确认${x.hit_count}次）`;
  });
  return `以下是用户过去人工核对后确认的纠错案例。只用于理解常见字形，不得脱离照片生搬硬套：\n${lines.join('\n')}`;
}
