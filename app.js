const $=id=>document.getElementById(id);
const E={settingsBtn:$('settingsBtn'),settingsPanel:$('settingsPanel'),closeSettings:$('closeSettings'),workerUrl:$('workerUrl'),saveWorker:$('saveWorker'),debugModelBtn:$('debugModelBtn'),connectionState:$('connectionState'),logoutBtn:$('logoutBtn'),authCard:$('authCard'),accessCode:$('accessCode'),authorizeBtn:$('authorizeBtn'),authStatus:$('authStatus'),mainCard:$('mainCard'),imageInput:$('imageInput'),preview:$('preview'),previewWrap:$('previewWrap'),resetZoomBtn:$('resetZoomBtn'),removeImage:$('removeImage'),recognizeBtn:$('recognizeBtn'),progress:$('progress'),status:$('status'),quota:$('quota'),resultCard:$('resultCard'),summary:$('summary'),resultBody:$('resultBody'),clearResult:$('clearResult'),copyBtn:$('copyBtn'),csvBtn:$('csvBtn'),xlsxBtn:$('xlsxBtn'),editAllBtn:$('editAllBtn'),compareWorkspace:$('compareWorkspace'),trainMin:$('trainMin'),trainMax:$('trainMax'),configBody:$('configBody'),configCount:$('configCount'),addConfigRow:$('addConfigRow'),sortConfig:$('sortConfig'),restoreConfig:$('restoreConfig'),saveConfig:$('saveConfig'),configStatus:$('configStatus')};
let file=null,rows=[],originalRows=[],editAllMode=false;
const DEFAULT_CONFIG={entries:[{table_no:31,time:'4:21'},{table_no:32,time:'4:46'},{table_no:33,time:'4:50'},{table_no:34,time:'4:52'},{table_no:35,time:'5:00'},{table_no:36,time:'5:08'},{table_no:37,time:'5:10'},{table_no:38,time:'5:16'},{table_no:39,time:'5:18'},{table_no:40,time:'5:38'},{table_no:41,time:'5:47'},{table_no:42,time:'5:51'},{table_no:43,time:'5:55'},{table_no:44,time:'5:59'},{table_no:45,time:'6:05'},{table_no:46,time:'6:09'},{table_no:47,time:'6:13'},{table_no:48,time:'6:19'},{table_no:49,time:'6:23'},{table_no:50,time:'6:27'},{table_no:51,time:'6:31'},{table_no:52,time:'6:35'},{table_no:53,time:'6:39'},{table_no:54,time:'6:43'},{table_no:55,time:'6:47'},{table_no:56,time:'6:51'},{table_no:57,time:'6:55'},{table_no:58,time:'7:00'},{table_no:59,time:'7:05'},{table_no:60,time:'7:17'},{table_no:61,time:'7:35'}],train_number:{min:1,max:112,unique:true}};
function cloneConfig(c){return JSON.parse(JSON.stringify(c))}
function sanitizeLocalConfig(raw){
  const fallback=cloneConfig(DEFAULT_CONFIG),src=raw&&typeof raw==='object'?raw:{};
  const entries=[];const seen=new Set();
  for(const x of Array.isArray(src.entries)?src.entries:[]){const n=Number(x.table_no),time=String(x.time??'').trim();if(!Number.isInteger(n)||n<1||n>9999||seen.has(n)||!time)continue;seen.add(n);entries.push({table_no:n,time:time.slice(0,20)})}
  if(!entries.length)return fallback;
  const min=Number(src.train_number?.min),max=Number(src.train_number?.max);
  return {entries,train_number:{min:Number.isInteger(min)&&min>=0&&min<=999?min:fallback.train_number.min,max:Number.isInteger(max)&&max>=0&&max<=999?max:fallback.train_number.max,unique:true}};
}
function loadConfig(){try{return sanitizeLocalConfig(JSON.parse(localStorage.getItem('ts_config_v253')||'null'))}catch{return cloneConfig(DEFAULT_CONFIG)}}
let sheetConfig=loadConfig(),draftConfig=cloneConfig(sheetConfig);
function configEntries(){return sheetConfig.entries}
function apiConfig(){return {entries:sheetConfig.entries.map(x=>({table_no:x.table_no,time:x.time})),train_number:{...sheetConfig.train_number,unique:true},track_unique:true}}
const state={get base(){return(localStorage.getItem('ts_worker')||'').replace(/\/+$/,'')},get token(){return localStorage.getItem('ts_token')||''},setToken(v){v?localStorage.setItem('ts_token',v):localStorage.removeItem('ts_token')}};
function status(el,msg,type=''){el.textContent=msg;el.className=`status ${type}`.trim()}
function authUI(ok){E.authCard.classList.toggle('hidden',ok);E.mainCard.classList.toggle('hidden',!ok)}
function headers(auth=true){const h={'Content-Type':'application/json'};if(auth&&state.token)h.Authorization=`Bearer ${state.token}`;return h}
async function api(path,options={}){if(!state.base)throw new Error('请先填写 Worker 地址');const r=await fetch(state.base+path,options);let d={};try{d=await r.json()}catch{}if(!r.ok){const e=new Error(d.error||`请求失败：${r.status}`);e.status=r.status;throw e}return d}
async function check(){if(!state.base){E.connectionState.textContent='请填写 Worker 地址。';authUI(false);return}try{const d=await api('/health',{headers:headers(false)});E.connectionState.textContent=d.ok?'Worker 连接正常。':'Worker 尚未配置完整。';if(state.token){try{const me=await api('/me',{headers:headers()});authUI(true);showQuota(me)}catch(e){if(e.status===401)state.setToken('');authUI(false)}}}catch(e){E.connectionState.textContent='连接失败：'+e.message;authUI(false)}}
function showQuota(d){if(!d)return;E.quota.textContent=`今日本设备 ${d.device_used}/${d.device_limit} 次；服务总计 ${d.global_used}/${d.global_limit} 次。令牌有效至 ${new Date(d.expires_at*1000).toLocaleDateString()}。`}
async function authorize(){const code=E.accessCode.value.trim();if(!code)return status(E.authStatus,'请输入设备授权码。','error');E.authorizeBtn.disabled=true;status(E.authStatus,'正在验证……');try{const d=await api('/auth',{method:'POST',headers:headers(false),body:JSON.stringify({code,device_name:navigator.userAgent.slice(0,120)})});state.setToken(d.token);E.accessCode.value='';authUI(true);showQuota(d);status(E.status,'设备已授权，请选择照片。','success')}catch(e){status(E.authStatus,e.message,'error')}finally{E.authorizeBtn.disabled=false}}
function resetImage(){resetPhotoZoom();file=null;E.imageInput.value='';E.preview.src='';E.previewWrap.classList.add('hidden');E.recognizeBtn.disabled=true;status(E.status,'请选择照片。')}
function compress(file,max=1900,quality=.86){return new Promise((res,rej)=>{const img=new Image(),u=URL.createObjectURL(file);img.onload=()=>{let w=img.width,h=img.height,s=Math.min(1,max/Math.max(w,h));w=Math.round(w*s);h=Math.round(h*s);const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);URL.revokeObjectURL(u);res(c.toDataURL('image/jpeg',quality))};img.onerror=()=>{URL.revokeObjectURL(u);rej(new Error('照片读取失败'))};img.src=u})}
function normalizeTrackName(value){let s=String(value??'').trim().toUpperCase();s=s.replace(/[→➡➜➝]/g,'').replace(/-?>/g,'').replace(/\s+/g,'').replace(/[，。,.；;:：]/g,'');const c=s.match(/^(\d{1,2})(东|西)$/);if(c)return c[1]+c[2];const a=s.match(/^(\d{1,2})(A|C)$/);if(a)return a[1]+(a[2]==='A'?'东':'西');return s}
function norm(input){const entries=configEntries(),allowed=new Set(entries.map(x=>x.table_no)),times=new Map(entries.map(x=>[x.table_no,x.time])),m=new Map();(Array.isArray(input)?input:[]).forEach(x=>{const n=Number(x.table_no);if(!allowed.has(n)||m.has(n))return;m.set(n,{table_no:n,time:times.get(n)||'',train_number:String(x.train_number??'').trim(),track_name:normalizeTrackName(x.track_name),old_train_number:String(x.old_train_number??'').trim(),old_track_name:normalizeTrackName(x.old_track_name),train_modified:Boolean(x.train_modified),track_modified:Boolean(x.track_modified),ambiguity:Boolean(x.ambiguity),needs_review:Boolean(x.needs_review),review_reasons:Array.isArray(x.review_reasons)?x.review_reasons.map(String):[],note:String(x.note??'').trim(),confidence:Math.max(0,Math.min(1,Number(x.confidence)||0))})});return entries.map(e=>m.get(e.table_no)||{table_no:e.table_no,time:e.time,train_number:'',track_name:'',old_train_number:'',old_track_name:'',train_modified:false,track_modified:false,ambiguity:true,needs_review:true,review_reasons:['模型未返回该表号'],note:'模型未返回该表号',confidence:0})}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function setCompareMode(on){E.compareWorkspace.classList.toggle('has-results',on);document.querySelector('.app').classList.toggle('compare-active',on)}
function render(){E.resultBody.innerHTML='';let n=0,modified=0,conflicts=0;rows.forEach((r,i)=>{const empty=!r.train_number||!r.track_name,review=Boolean(r.needs_review)||r.confidence<.88||r.ambiguity||empty;if(review)n++;if(r.train_modified||r.track_modified)modified++;if((r.review_reasons||[]).some(x=>x.includes('重复')))conflicts++;const tr=document.createElement('tr');if(review)tr.classList.add('review');if(r.ambiguity)tr.classList.add('high-risk');if(empty)tr.classList.add('empty');const reasons=(r.review_reasons||[]).join('；')||r.note||'';if(reasons)tr.title=`表号${r.table_no}：${reasons}`;const locked=!editAllMode&&!review;tr.innerHTML=`<td class="table-number">${esc(r.table_no)}</td><td class="fixed-time">${esc(r.time)}${review?'<span class="row-alert">需核对</span>':''}</td><td><input aria-label="表号${r.table_no}车号" data-i="${i}" data-k="train_number" value="${esc(r.train_number)}" placeholder="空" ${locked?'readonly':''}></td><td><input aria-label="表号${r.table_no}股道" data-i="${i}" data-k="track_name" value="${esc(r.track_name)}" placeholder="空" ${locked?'readonly':''}></td>`;if(locked)tr.classList.add('locked-row');E.resultBody.appendChild(tr)});E.summary.textContent=`${rows.length}条记录，${n}行需要人工确认；检测到${modified}行涂改，${conflicts}行涉及重复冲突。黄色行可直接修改；也可点击“编辑全部”修改任何结果。`;E.editAllBtn.textContent=editAllMode?'完成全部编辑':'编辑全部车号/股道';E.editAllBtn.classList.toggle('active',editAllMode);E.resultCard.classList.remove('hidden');setCompareMode(true);requestAnimationFrame(()=>E.compareWorkspace.scrollIntoView({behavior:'smooth',block:'start'}))}

async function debugModel(){
  if(!state.token){status(E.authStatus,'请先完成设备授权。','error');return}
  E.debugModelBtn.disabled=true;
  E.progress.classList.remove('hidden');
  status(E.status,'正在测试大模型文字接口，不上传照片……');
  E.connectionState.textContent='正在测试大模型连接……';
  const t0=Date.now();
  try{
    const d=await api('/debug-model',{method:'POST',headers:headers(),body:JSON.stringify({})});
    const sec=((Date.now()-t0)/1000).toFixed(1);
    E.connectionState.textContent=`大模型连接正常：${d.provider||''} / ${d.model||''}，耗时${d.elapsed_ms||Math.round(sec*1000)}ms。`;
    status(E.status,`大模型文字测试成功，耗时${sec}秒。现在可以再测试照片识别。`,'success');
  }catch(e){
    if(e.status===401){state.setToken('');authUI(false)}
    E.connectionState.textContent='大模型连接测试失败：'+e.message;
    status(E.status,'大模型连接测试失败：'+e.message,'error');
  }finally{
    E.progress.classList.add('hidden');
    E.debugModelBtn.disabled=false;
  }
}
async function recognize(){if(!file)return;E.recognizeBtn.disabled=true;E.progress.classList.remove('hidden');let timer=null;status(E.status,'正在本地压缩照片……');try{const image=await compress(file);const start=Date.now();timer=setInterval(()=>{const s=Math.floor((Date.now()-start)/1000);status(E.status,`大模型正在识别当前配置的 ${sheetConfig.entries.length} 个表号……已等待 ${s} 秒`);},1000);status(E.status,`大模型正在识别当前配置的 ${sheetConfig.entries.length} 个表号……已等待 0 秒`);const d=await api('/recognize',{method:'POST',headers:headers(),body:JSON.stringify({image,config:apiConfig()})});rows=norm(d.rows);originalRows=rows.map(r=>({...r}));render();showQuota(d.usage);const extra=d.model_provider?`模型：${d.model_provider} / ${d.model_name||''}，耗时${Math.round((d.elapsed_ms||0)/1000)}秒。`:'';status(E.status,'识别完成：时间来自当前配置，请核对车号和股道。'+extra,'success')}catch(e){if(e.status===401){state.setToken('');authUI(false)}status(E.status,e.message,'error')}finally{if(timer)clearInterval(timer);E.progress.classList.add('hidden');E.recognizeBtn.disabled=!file}}
function csvEsc(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s}
function exportCsv(){const lines=[['表号','车号','时间','股道'],...rows.map(r=>[r.table_no,r.train_number,r.time,r.track_name])].map(x=>x.map(csvEsc).join(','));const b=new Blob(['\uFEFF'+lines.join('\n')],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`全股道时刻表_${safeFileDate()}.csv`;a.click();URL.revokeObjectURL(a.href)}
function safeFileDate(){const d=new Date(),pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`}
async function saveLearning(){const corrections=[];for(let i=0;i<rows.length;i++){const before=originalRows[i]||{},after=rows[i]||{};for(const fieldType of ['train_number','track_name']){const originalValue=String(before[fieldType]??'').trim(),correctedValue=String(after[fieldType]??'').trim();if(originalValue!==correctedValue)corrections.push({table_no:Number(after.table_no),field_type:fieldType,original_value:originalValue,corrected_value:correctedValue,old_value:fieldType==='train_number'?String(before.old_train_number??''):String(before.old_track_name??''),modified:fieldType==='train_number'?Boolean(before.train_modified):Boolean(before.track_modified),ambiguity:Boolean(before.ambiguity),model_note:String(before.note??'').slice(0,300),review_reasons:Array.isArray(before.review_reasons)?before.review_reasons.slice(0,8):[]})}}if(!corrections.length)return{saved:0,total:0};return api('/learn',{method:'POST',headers:headers(),body:JSON.stringify({corrections})})}
async function downloadBlob(blob, filename){
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
}
async function exportXlsx(){
  if(!rows.length)return status(E.status,'当前没有可导出的识别结果。','error');
  if(typeof ExcelJS==='undefined')return status(E.status,'Excel 模板组件尚未加载，请检查网络后刷新页面。','error');
  const missing=rows.some(r=>!String(r.train_number).trim()||!String(r.track_name).trim());
  const message=missing?'仍有车号或股道为空。确认这些确实为空，并保存学习、下载 XLSX 吗？':'确认已对照原照片核对完毕，并保存纠错、按原始模板下载 XLSX 吗？';
  if(!window.confirm(message))return;
  E.xlsxBtn.disabled=true;
  status(E.status,'正在保存人工纠错……');
  let learnMessage='';
  try{
    const learned=await saveLearning();
    learnMessage=Number(learned.saved||0)>0?`已保存 ${learned.saved} 条纠错记忆。`:'本次没有需要保存的修正。';
    originalRows=rows.map(r=>({...r}));
  }catch(e){
    if(!window.confirm(`纠错记忆保存失败：${e.message}

是否仍然下载 XLSX？`)){
      status(E.status,'已取消下载。','error');
      E.xlsxBtn.disabled=false;
      return;
    }
    learnMessage='纠错记忆保存失败，但已继续导出。';
  }
  try{
    status(E.status,'正在套用原始 Excel 模板……');
    const response=await fetch('./template.xlsx',{cache:'no-store'});
    if(!response.ok)throw new Error(`模板读取失败：${response.status}`);
    const buffer=await response.arrayBuffer();
    const workbook=new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet=workbook.getWorksheet('全股道时刻表')||workbook.worksheets[0];
    if(!worksheet)throw new Error('模板中找不到工作表');

    const originalRowCount=worksheet.rowCount;
    const styleSourceRow=Math.min(Math.max(2,originalRowCount),32);
    while(worksheet.rowCount<rows.length+1){
      const target=worksheet.addRow([]),source=worksheet.getRow(styleSourceRow);
      target.height=source.height;
      for(let col=1;col<=3;col++){
        const s=source.getCell(col),t=target.getCell(col);
        t.style=JSON.parse(JSON.stringify(s.style||{}));
        if(s.numFmt)t.numFmt=s.numFmt;
        t.alignment=s.alignment?JSON.parse(JSON.stringify(s.alignment)):t.alignment;
        t.border=s.border?JSON.parse(JSON.stringify(s.border)):t.border;
        t.fill=s.fill?JSON.parse(JSON.stringify(s.fill)):t.fill;
        t.font=s.font?JSON.parse(JSON.stringify(s.font)):t.font;
      }
    }
    rows.forEach((r,i)=>{
      const row=i+2;
      const train=String(r.train_number??'').trim().padStart(3,'0').slice(-3);
      const track=normalizeTrackName(r.track_name);
      const trainCell=worksheet.getCell(`A${row}`);
      trainCell.value=train;
      trainCell.numFmt='@';
      worksheet.getCell(`B${row}`).value=String(r.time??'').trim();
      worksheet.getCell(`C${row}`).value=track;
    });
    for(let row=rows.length+2;row<=worksheet.rowCount;row++){
      worksheet.getCell(`A${row}`).value=null;
      worksheet.getCell(`B${row}`).value=null;
      worksheet.getCell(`C${row}`).value=null;
    }

    const output=await workbook.xlsx.writeBuffer();
    await downloadBlob(new Blob([output],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),`全股道时刻表-按车号排列_${safeFileDate()}.xlsx`);
    status(E.status,`${learnMessage} 已按原始模板生成 XLSX。`,'success');
  }catch(e){
    status(E.status,'生成模板 XLSX 失败：'+e.message,'error');
  }finally{
    E.xlsxBtn.disabled=false;
  }
}


function renderConfigEditor(){
  E.trainMin.value=draftConfig.train_number.min;E.trainMax.value=draftConfig.train_number.max;E.configBody.innerHTML='';
  draftConfig.entries.forEach((entry,i)=>{const tr=document.createElement('tr');tr.innerHTML=`<td><input data-config-i="${i}" data-config-k="table_no" type="number" min="1" max="9999" inputmode="numeric" value="${esc(entry.table_no)}"></td><td><input data-config-i="${i}" data-config-k="time" type="text" maxlength="20" value="${esc(entry.time)}" placeholder="例如 4:21"></td><td><button class="config-delete" data-config-delete="${i}" type="button" aria-label="删除">×</button></td>`;E.configBody.appendChild(tr)});
  E.configCount.textContent=`当前草稿共 ${draftConfig.entries.length} 个表号。`;
}
function syncDraftConfig(){draftConfig.train_number.min=Number(E.trainMin.value);draftConfig.train_number.max=Number(E.trainMax.value);}
function validateDraftConfig(){syncDraftConfig();if(!Number.isInteger(draftConfig.train_number.min)||!Number.isInteger(draftConfig.train_number.max)||draftConfig.train_number.min<0||draftConfig.train_number.max>999||draftConfig.train_number.min>draftConfig.train_number.max)throw new Error('车号范围必须是0—999之间的有效整数，且最小值不能大于最大值。');if(!draftConfig.entries.length)throw new Error('至少需要保留一个表号。');if(draftConfig.entries.length>100)throw new Error('一次最多配置100个表号。');const seen=new Set();for(const x of draftConfig.entries){const n=Number(x.table_no),time=String(x.time??'').trim();if(!Number.isInteger(n)||n<1||n>9999)throw new Error('表号必须是1—9999之间的整数。');if(seen.has(n))throw new Error(`表号${n}重复。`);seen.add(n);if(!time)throw new Error(`表号${n}还没有填写时间。`);x.table_no=n;x.time=time.slice(0,20)}return true}
function resetRecognitionForConfigChange(){if(rows.length){rows=[];originalRows=[];editAllMode=false;E.resultCard.classList.add('hidden');setCompareMode(false)}}
function openConfigEditor(){draftConfig=cloneConfig(sheetConfig);renderConfigEditor()}
E.configBody.oninput=e=>{const x=e.target.closest('[data-config-i]');if(!x)return;const i=Number(x.dataset.configI),k=x.dataset.configK;if(!draftConfig.entries[i])return;draftConfig.entries[i][k]=k==='table_no'?Number(x.value):x.value;E.configCount.textContent=`当前草稿共 ${draftConfig.entries.length} 个表号。`};
E.configBody.onclick=e=>{const b=e.target.closest('[data-config-delete]');if(!b)return;draftConfig.entries.splice(Number(b.dataset.configDelete),1);renderConfigEditor()};
E.addConfigRow.onclick=()=>{syncDraftConfig();const max=draftConfig.entries.reduce((m,x)=>Math.max(m,Number(x.table_no)||0),30);draftConfig.entries.push({table_no:max+1,time:''});renderConfigEditor();setTimeout(()=>E.configBody.querySelector('tr:last-child input')?.focus(),0)};
E.sortConfig.onclick=()=>{syncDraftConfig();draftConfig.entries.sort((a,b)=>(Number(a.table_no)||0)-(Number(b.table_no)||0));renderConfigEditor()};
E.restoreConfig.onclick=()=>{if(!window.confirm('恢复为当前默认的31—61表号和时间吗？'))return;draftConfig=cloneConfig(DEFAULT_CONFIG);renderConfigEditor();status(E.configStatus,'已恢复默认草稿，点击“保存车表配置”后生效。','success')};
E.saveConfig.onclick=()=>{try{validateDraftConfig();sheetConfig=cloneConfig(draftConfig);localStorage.setItem('ts_config_v253',JSON.stringify(sheetConfig));resetRecognitionForConfigChange();renderConfigEditor();status(E.configStatus,`配置已保存：${sheetConfig.entries.length}个表号，车号范围${String(sheetConfig.train_number.min).padStart(3,'0')}—${String(sheetConfig.train_number.max).padStart(3,'0')}。`,'success');status(E.status,'车表配置已更新，请重新选择或识别照片。','success')}catch(e){status(E.configStatus,e.message,'error')}};

// 左侧原图独立手势控制：只缩放/拖动图片，不触发整页缩放
const photoStage = E.previewWrap ? E.previewWrap.querySelector('.photo-stage') : null;
const photoGesture = {
  scale: 1,
  x: 0,
  y: 0,
  startScale: 1,
  startX: 0,
  startY: 0,
  startMidX: 0,
  startMidY: 0,
  startDistance: 0,
  lastTouchX: 0,
  lastTouchY: 0,
  dragging: false
};

function applyPhotoTransform(){
  if(!E.preview) return;
  E.preview.style.transform = `translate3d(${photoGesture.x}px, ${photoGesture.y}px, 0) scale(${photoGesture.scale})`;
}

function clampPhotoPosition(){
  if(!photoStage || !E.preview) return;
  const stageW = photoStage.clientWidth;
  const stageH = photoStage.clientHeight;
  const baseW = E.preview.offsetWidth;
  const baseH = E.preview.offsetHeight;
  const scaledW = baseW * photoGesture.scale;
  const scaledH = baseH * photoGesture.scale;

  const minX = Math.min(0, stageW - scaledW);
  const minY = Math.min(0, stageH - scaledH);
  const maxX = Math.max(0, (stageW - scaledW) / 2);
  const maxY = Math.max(0, (stageH - scaledH) / 2);

  photoGesture.x = Math.min(maxX, Math.max(minX, photoGesture.x));
  photoGesture.y = Math.min(maxY, Math.max(minY, photoGesture.y));
}

function resetPhotoZoom(){
  photoGesture.scale = 1;
  photoGesture.x = 0;
  photoGesture.y = 0;
  applyPhotoTransform();
}

function touchDistance(a,b){
  return Math.hypot(b.clientX-a.clientX,b.clientY-a.clientY);
}
function touchMidpoint(a,b,rect){
  return {
    x:(a.clientX+b.clientX)/2-rect.left,
    y:(a.clientY+b.clientY)/2-rect.top
  };
}

if(photoStage){
  photoStage.addEventListener('touchstart', event=>{
    if(event.touches.length===2){
      event.preventDefault();
      const rect=photoStage.getBoundingClientRect();
      const mid=touchMidpoint(event.touches[0],event.touches[1],rect);
      photoGesture.startDistance=touchDistance(event.touches[0],event.touches[1]);
      photoGesture.startScale=photoGesture.scale;
      photoGesture.startX=photoGesture.x;
      photoGesture.startY=photoGesture.y;
      photoGesture.startMidX=mid.x;
      photoGesture.startMidY=mid.y;
      photoGesture.dragging=false;
    }else if(event.touches.length===1 && photoGesture.scale>1){
      event.preventDefault();
      photoGesture.lastTouchX=event.touches[0].clientX;
      photoGesture.lastTouchY=event.touches[0].clientY;
      photoGesture.dragging=true;
    }
  },{passive:false});

  photoStage.addEventListener('touchmove', event=>{
    if(event.touches.length===2 && photoGesture.startDistance>0){
      event.preventDefault();
      const rect=photoStage.getBoundingClientRect();
      const mid=touchMidpoint(event.touches[0],event.touches[1],rect);
      const rawScale=photoGesture.startScale*
        (touchDistance(event.touches[0],event.touches[1])/photoGesture.startDistance);
      const newScale=Math.min(5,Math.max(1,rawScale));
      const ratio=newScale/photoGesture.startScale;

      // 以两指中心为缩放中心，保持照片指向稳定
      photoGesture.x=mid.x-(photoGesture.startMidX-photoGesture.startX)*ratio;
      photoGesture.y=mid.y-(photoGesture.startMidY-photoGesture.startY)*ratio;
      photoGesture.scale=newScale;
      clampPhotoPosition();
      applyPhotoTransform();
    }else if(event.touches.length===1 && photoGesture.dragging && photoGesture.scale>1){
      event.preventDefault();
      const touch=event.touches[0];
      photoGesture.x+=touch.clientX-photoGesture.lastTouchX;
      photoGesture.y+=touch.clientY-photoGesture.lastTouchY;
      photoGesture.lastTouchX=touch.clientX;
      photoGesture.lastTouchY=touch.clientY;
      clampPhotoPosition();
      applyPhotoTransform();
    }
  },{passive:false});

  photoStage.addEventListener('touchend', event=>{
    if(event.touches.length<2) photoGesture.startDistance=0;
    if(event.touches.length===0) photoGesture.dragging=false;
    if(photoGesture.scale<=1.01) resetPhotoZoom();
  },{passive:false});
}

if(E.resetZoomBtn) E.resetZoomBtn.onclick=resetPhotoZoom;

E.settingsBtn.onclick=()=>{const opening=E.settingsPanel.classList.contains('hidden');E.settingsPanel.classList.toggle('hidden');if(opening)openConfigEditor()};E.closeSettings.onclick=()=>E.settingsPanel.classList.add('hidden');E.saveWorker.onclick=()=>{localStorage.setItem('ts_worker',E.workerUrl.value.trim().replace(/\/+$/,''));check()};E.debugModelBtn.onclick=debugModel;E.logoutBtn.onclick=()=>{state.setToken('');authUI(false);status(E.authStatus,'本机令牌已删除。','success')};E.authorizeBtn.onclick=authorize;E.imageInput.onchange=()=>{const f=E.imageInput.files?.[0];if(!f)return;if(!/^image\/(jpeg|png|webp)$/.test(f.type))return status(E.status,'只支持JPG、PNG或WebP。','error');if(f.size>12*1024*1024)return status(E.status,'原图不能超过12MB。','error');file=f;resetPhotoZoom();E.preview.src=URL.createObjectURL(f);E.previewWrap.classList.remove('hidden');E.recognizeBtn.disabled=false;status(E.status,'照片已选择。')};E.removeImage.onclick=resetImage;E.recognizeBtn.onclick=recognize;E.resultBody.oninput=e=>{const x=e.target.closest('input[data-i]');if(x){const i=Number(x.dataset.i),k=x.dataset.k;rows[i][k]=k==='track_name'?normalizeTrackName(x.value):x.value.trim();if(k==='track_name'&&document.activeElement!==x)x.value=rows[i][k]}};E.resultBody.onchange=e=>{const x=e.target.closest('input[data-i]');if(x&&x.dataset.k==='track_name'){rows[Number(x.dataset.i)].track_name=normalizeTrackName(x.value);x.value=rows[Number(x.dataset.i)].track_name}};E.editAllBtn.onclick=()=>{editAllMode=!editAllMode;render();status(E.status,editAllMode?'已开放全部车号和股道，可逐项修改。':'已结束全部编辑；黄色行仍可继续修改。','success')};E.clearResult.onclick=()=>{rows=[];originalRows=[];editAllMode=false;E.resultCard.classList.add('hidden');setCompareMode(false)};E.copyBtn.onclick=async()=>{const t=[['表号','车号','时间','股道'],...rows.map(r=>[r.table_no,r.train_number,r.time,r.track_name])].map(x=>x.join('\t')).join('\n');try{await navigator.clipboard.writeText(t);status(E.status,'已复制，可粘贴到WPS或Excel。','success')}catch{status(E.status,'复制失败，请导出XLSX。','error')}};E.csvBtn.onclick=exportCsv;E.xlsxBtn.onclick=exportXlsx;E.workerUrl.value=state.base;openConfigEditor();authUI(!!state.token);check();if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
