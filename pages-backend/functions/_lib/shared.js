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

export function normalizeTrainNumber(value){
  const raw=String(value??'').trim();
  if(!raw)return '';
  if(!/^\d{1,3}$/.test(raw))return raw;
  return raw.padStart(3,'0');
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
      train_number:normalizeTrainNumber(x.train_number),
      track_name:normalizeTrackName(x.track_name),
      old_train_number:normalizeTrainNumber(x.old_train_number),
      old_track_name:normalizeTrackName(x.old_track_name),
      train_modified:Boolean(x.train_modified),
      track_modified:Boolean(x.track_modified),
      ambiguity:Boolean(x.ambiguity),
      note:String(x.note??'').trim(),
      confidence:Math.max(0,Math.min(1,Number(x.confidence)||0)),
      needs_review:false,
      review_reasons:[]
    });
  }
  const rows=Array.from({length:31},(_,i)=>m.get(i+31)||{
    table_no:i+31,time:FIXED_TIMES[i],train_number:'',track_name:'',old_train_number:'',old_track_name:'',
    train_modified:false,track_modified:false,ambiguity:true,
    note:'模型未返回该表号',confidence:0,needs_review:true,review_reasons:['模型未返回该表号']
  });

  const trainMap=new Map(),trackMap=new Map();
  for(const r of rows){
    const reasons=[];
    const n=Number(r.train_number);
    if(!r.train_number)reasons.push('车号为空');
    else if(!/^\d{3}$/.test(r.train_number)||n<1||n>112)reasons.push('车号不在001—112范围内');
    if(!r.track_name)reasons.push('股道为空');
    if(r.train_modified)reasons.push('车号存在划掉或重写');
    if(r.track_modified)reasons.push('股道存在划掉或重写');
    if(r.ambiguity)reasons.push('模型认为最终值仍不确定');
    if(r.confidence<0.88)reasons.push('最终值置信度不足');
    r.review_reasons=reasons;
    if(/^\d{3}$/.test(r.train_number)&&n>=1&&n<=112){
      if(!trainMap.has(r.train_number))trainMap.set(r.train_number,[]);
      trainMap.get(r.train_number).push(r);
    }
    if(r.track_name){
      if(!trackMap.has(r.track_name))trackMap.set(r.track_name,[]);
      trackMap.get(r.track_name).push(r);
    }
  }
  for(const [value,list] of trainMap){if(list.length>1)for(const r of list)r.review_reasons.push(`车号${value}重复`)}
  for(const [value,list] of trackMap){if(list.length>1)for(const r of list)r.review_reasons.push(`股道${value}重复`)}
  for(const r of rows){
    r.review_reasons=[...new Set(r.review_reasons)];
    r.needs_review=r.review_reasons.length>0;
    if(r.review_reasons.length){
      const extra=r.review_reasons.join('；');
      r.note=r.note?`${r.note}；${extra}`:extra;
    }
  }
  return rows;
}

export async function getCorrectionExamples(db, limit = 24) {
  try {
    const result = await db.prepare(`
      SELECT track, field_type, original_value, corrected_value, hit_count
      FROM correction_memory
      WHERE original_value <> corrected_value
        AND field_type IN ('train_number','track_name')
      ORDER BY hit_count DESC, updated_at DESC
      LIMIT ?
    `).bind(limit).all();
    return result.results || [];
  } catch (_) {
    try {
      const legacy = await db.prepare(`
        SELECT track, field AS field_type, predicted AS original_value,
               corrected AS corrected_value, occurrences AS hit_count
        FROM correction_memory
        WHERE predicted <> corrected
        ORDER BY occurrences DESC, updated_at DESC
        LIMIT ?
      `).bind(limit).all();
      return legacy.results || [];
    } catch (_) {
      return [];
    }
  }
}

export function correctionExamplesPrompt(examples) {
  if (!examples?.length) return '暂无历史人工纠错案例。';
  const lines = examples.map(x => {
    const label = x.field_type === 'track_name' ? '股道' : '车号';
    const before = x.original_value === '' ? '（空）' : x.original_value;
    const after = x.corrected_value === '' ? '（空）' : x.corrected_value;
    return `${label}: 模型曾识别为${before}，人工最终确认${after}（累计${x.hit_count}次）`;
  });
  return `以下是历史人工纠错摘要。它们只能帮助理解常见误读与修改语义，绝不代表表号与答案固定对应：\n${lines.join('\n')}`;
}
