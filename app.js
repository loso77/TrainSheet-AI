const $=id=>document.getElementById(id);
const E={settingsBtn:$('settingsBtn'),settingsPanel:$('settingsPanel'),closeSettings:$('closeSettings'),workerUrl:$('workerUrl'),saveWorker:$('saveWorker'),connectionState:$('connectionState'),logoutBtn:$('logoutBtn'),authCard:$('authCard'),accessCode:$('accessCode'),authorizeBtn:$('authorizeBtn'),authStatus:$('authStatus'),mainCard:$('mainCard'),imageInput:$('imageInput'),preview:$('preview'),previewWrap:$('previewWrap'),resetZoomBtn:$('resetZoomBtn'),removeImage:$('removeImage'),recognizeBtn:$('recognizeBtn'),progress:$('progress'),status:$('status'),quota:$('quota'),resultCard:$('resultCard'),summary:$('summary'),resultBody:$('resultBody'),clearResult:$('clearResult'),copyBtn:$('copyBtn'),csvBtn:$('csvBtn'),xlsxBtn:$('xlsxBtn'),compareWorkspace:$('compareWorkspace')};
let file=null,rows=[],originalRows=[];
const TABLE_NOS=Array.from({length:31},(_,i)=>31+i);
const FIXED_TIMES=['4:21','4:46','4:50','4:52','5:00','5:08','5:10','5:16','5:18','5:38','5:47','5:51','5:55','5:59','6:05','6:09','6:13','6:19','6:23','6:27','6:31','6:35','6:39','6:43','6:47','6:51','6:55','7:00','7:05','7:17','7:35'];
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
function norm(input){const m=new Map();(Array.isArray(input)?input:[]).forEach(x=>{const n=Number(x.table_no);if(!TABLE_NOS.includes(n)||m.has(n))return;m.set(n,{table_no:n,time:FIXED_TIMES[n-31],train_number:String(x.train_number??'').trim(),track_name:normalizeTrackName(x.track_name),note:String(x.note??'').trim(),confidence:Math.max(0,Math.min(1,Number(x.confidence)||0))})});return TABLE_NOS.map((n,i)=>m.get(n)||{table_no:n,time:FIXED_TIMES[i],train_number:'',track_name:'',note:'模型未返回该表号',confidence:0})}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function setCompareMode(on){E.compareWorkspace.classList.toggle('has-results',on);document.querySelector('.app').classList.toggle('compare-active',on)}
function render(){E.resultBody.innerHTML='';let n=0;rows.forEach((r,i)=>{const empty=!r.train_number||!r.track_name,review=r.confidence<.78||r.note||empty;if(review)n++;const tr=document.createElement('tr');if(review)tr.classList.add('review');if(empty)tr.classList.add('empty');tr.innerHTML=`<td class="fixed-time">${esc(r.time)}</td><td><input data-i="${i}" data-k="train_number" value="${esc(r.train_number)}" placeholder="空"></td><td><input data-i="${i}" data-k="track_name" value="${esc(r.track_name)}" placeholder="空"></td>`;E.resultBody.appendChild(tr)});E.summary.textContent=`31条记录，${n}行需要人工确认。时间已按固定时刻表套用。`;E.resultCard.classList.remove('hidden');setCompareMode(true);requestAnimationFrame(()=>E.compareWorkspace.scrollIntoView({behavior:'smooth',block:'start'}))}
async function recognize(){if(!file)return;E.recognizeBtn.disabled=true;E.progress.classList.remove('hidden');status(E.status,'正在本地压缩照片……');try{const image=await compress(file);status(E.status,'大模型正在按表号识别车号和股道……');const d=await api('/recognize',{method:'POST',headers:headers(),body:JSON.stringify({image})});rows=norm(d.rows);originalRows=rows.map(r=>({...r}));render();showQuota(d.usage);status(E.status,'识别完成：时间为固定值，请核对车号和股道。','success')}catch(e){if(e.status===401){state.setToken('');authUI(false)}status(E.status,e.message,'error')}finally{E.progress.classList.add('hidden');E.recognizeBtn.disabled=!file}}
function csvEsc(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s}
function exportCsv(){const lines=[['车号','时间','股道'],...rows.map(r=>[r.train_number,r.time,r.track_name])].map(x=>x.map(csvEsc).join(','));const b=new Blob(['\uFEFF'+lines.join('\n')],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`全股道时刻表_${safeFileDate()}.csv`;a.click();URL.revokeObjectURL(a.href)}
function safeFileDate(){const d=new Date(),pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`}
async function saveLearning(){const corrections=[];for(let i=0;i<rows.length;i++){const before=originalRows[i]||{},after=rows[i]||{};for(const fieldType of ['train_number','track_name']){const originalValue=String(before[fieldType]??'').trim(),correctedValue=String(after[fieldType]??'').trim();if(originalValue!==correctedValue)corrections.push({table_no:Number(after.table_no),field_type:fieldType,original_value:originalValue,corrected_value:correctedValue})}}if(!corrections.length)return{saved:0,total:0};return api('/learn',{method:'POST',headers:headers(),body:JSON.stringify({corrections})})}
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

    rows.forEach((r,i)=>{
      const row=i+2;
      const train=String(r.train_number??'').trim().padStart(3,'0').slice(-3);
      const track=normalizeTrackName(r.track_name);
      const trainCell=worksheet.getCell(`A${row}`);
      trainCell.value=train;
      trainCell.numFmt='@';
      worksheet.getCell(`C${row}`).value=track;
      // B列固定时间完全保留模板原值和格式
    });

    // 清除超过31条记录之后可能残留的数据，但不破坏模板样式
    for(let row=33;row<=worksheet.rowCount;row++){
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

E.settingsBtn.onclick=()=>E.settingsPanel.classList.toggle('hidden');E.closeSettings.onclick=()=>E.settingsPanel.classList.add('hidden');E.saveWorker.onclick=()=>{localStorage.setItem('ts_worker',E.workerUrl.value.trim().replace(/\/+$/,''));check()};E.logoutBtn.onclick=()=>{state.setToken('');authUI(false);status(E.authStatus,'本机令牌已删除。','success')};E.authorizeBtn.onclick=authorize;E.imageInput.onchange=()=>{const f=E.imageInput.files?.[0];if(!f)return;if(!/^image\/(jpeg|png|webp)$/.test(f.type))return status(E.status,'只支持JPG、PNG或WebP。','error');if(f.size>12*1024*1024)return status(E.status,'原图不能超过12MB。','error');file=f;resetPhotoZoom();E.preview.src=URL.createObjectURL(f);E.previewWrap.classList.remove('hidden');E.recognizeBtn.disabled=false;status(E.status,'照片已选择。')};E.removeImage.onclick=resetImage;E.recognizeBtn.onclick=recognize;E.resultBody.oninput=e=>{const x=e.target.closest('input[data-i]');if(x){const i=Number(x.dataset.i),k=x.dataset.k;rows[i][k]=k==='track_name'?normalizeTrackName(x.value):x.value.trim();if(k==='track_name'&&document.activeElement!==x)x.value=rows[i][k]}};E.resultBody.onchange=e=>{const x=e.target.closest('input[data-i]');if(x&&x.dataset.k==='track_name'){rows[Number(x.dataset.i)].track_name=normalizeTrackName(x.value);x.value=rows[Number(x.dataset.i)].track_name}};E.clearResult.onclick=()=>{rows=[];originalRows=[];E.resultCard.classList.add('hidden');setCompareMode(false)};E.copyBtn.onclick=async()=>{const t=[['车号','时间','股道'],...rows.map(r=>[r.train_number,r.time,r.track_name])].map(x=>x.join('\t')).join('\n');try{await navigator.clipboard.writeText(t);status(E.status,'已复制，可粘贴到WPS或Excel。','success')}catch{status(E.status,'复制失败，请导出XLSX。','error')}};E.csvBtn.onclick=exportCsv;E.xlsxBtn.onclick=exportXlsx;E.workerUrl.value=state.base;authUI(!!state.token);check();if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
