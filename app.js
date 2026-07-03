const $=id=>document.getElementById(id);
const E={settingsBtn:$("settingsBtn"),settingsPanel:$("settingsPanel"),closeSettings:$("closeSettings"),workerUrl:$("workerUrl"),saveWorker:$("saveWorker"),connectionState:$("connectionState"),logoutBtn:$("logoutBtn"),authCard:$("authCard"),accessCode:$("accessCode"),authorizeBtn:$("authorizeBtn"),authStatus:$("authStatus"),mainCard:$("mainCard"),imageInput:$("imageInput"),preview:$("preview"),previewWrap:$("previewWrap"),removeImage:$("removeImage"),recognizeBtn:$("recognizeBtn"),progress:$("progress"),status:$("status"),quota:$("quota"),resultCard:$("resultCard"),summary:$("summary"),resultBody:$("resultBody"),clearResult:$("clearResult"),copyBtn:$("copyBtn"),csvBtn:$("csvBtn"),xlsxBtn:$("xlsxBtn"),compareWorkspace:$("compareWorkspace")};
let file=null,rows=[],originalRows=[];
const tracks=Array.from({length:31},(_,i)=>31+i);
const state={get base(){return(localStorage.getItem("ts_worker")||"").replace(/\/+$/,"")},get token(){return localStorage.getItem("ts_token")||""},setToken(v){v?localStorage.setItem("ts_token",v):localStorage.removeItem("ts_token")}};
function status(el,msg,type=""){el.textContent=msg;el.className=`status ${type}`.trim()}
function authUI(ok){E.authCard.classList.toggle("hidden",ok);E.mainCard.classList.toggle("hidden",!ok)}
function headers(auth=true){const h={"Content-Type":"application/json"};if(auth&&state.token)h.Authorization=`Bearer ${state.token}`;return h}
async function api(path,options={}){if(!state.base)throw new Error("请先填写 Worker 地址");const r=await fetch(state.base+path,options);let d={};try{d=await r.json()}catch{}if(!r.ok){const e=new Error(d.error||`请求失败：${r.status}`);e.status=r.status;throw e}return d}
async function check(){if(!state.base){E.connectionState.textContent="请填写 Worker 地址。";authUI(false);return}try{const d=await api("/health",{headers:headers(false)});E.connectionState.textContent=d.ok?"Worker 连接正常。":"Worker 尚未配置完整。";if(state.token){try{const me=await api("/me",{headers:headers()});authUI(true);showQuota(me)}catch(e){if(e.status===401)state.setToken("");authUI(false)}}}catch(e){E.connectionState.textContent="连接失败："+e.message;authUI(false)}}
function showQuota(d){if(!d)return;E.quota.textContent=`今日本设备 ${d.device_used}/${d.device_limit} 次；服务总计 ${d.global_used}/${d.global_limit} 次。令牌有效至 ${new Date(d.expires_at*1000).toLocaleDateString()}。`}
async function authorize(){const code=E.accessCode.value.trim();if(!code)return status(E.authStatus,"请输入设备授权码。","error");E.authorizeBtn.disabled=true;status(E.authStatus,"正在验证……");try{const d=await api("/auth",{method:"POST",headers:headers(false),body:JSON.stringify({code,device_name:navigator.userAgent.slice(0,120)})});state.setToken(d.token);E.accessCode.value="";authUI(true);showQuota(d);status(E.status,"设备已授权，请选择照片。","success")}catch(e){status(E.authStatus,e.message,"error")}finally{E.authorizeBtn.disabled=false}}
function resetImage(){file=null;E.imageInput.value="";E.preview.src="";E.previewWrap.classList.add("hidden");E.recognizeBtn.disabled=true;status(E.status,"请选择照片。")}
function compress(file,max=1900,quality=.86){return new Promise((res,rej)=>{const img=new Image(),u=URL.createObjectURL(file);img.onload=()=>{let w=img.width,h=img.height,s=Math.min(1,max/Math.max(w,h));w=Math.round(w*s);h=Math.round(h*s);const c=document.createElement("canvas");c.width=w;c.height=h;c.getContext("2d").drawImage(img,0,0,w,h);URL.revokeObjectURL(u);res(c.toDataURL("image/jpeg",quality))};img.onerror=()=>{URL.revokeObjectURL(u);rej(new Error("照片读取失败"))};img.src=u})}
function norm(input){const m=new Map;(Array.isArray(input)?input:[]).forEach(x=>{const t=Number(x.track);if(!tracks.includes(t)||m.has(t))return;m.set(t,{track:t,time:String(x.time??"").trim(),train_number:String(x.train_number??"").trim(),note:String(x.note??"").trim(),confidence:Math.max(0,Math.min(1,Number(x.confidence)||0))})});return tracks.map(t=>m.get(t)||{track:t,time:"",train_number:"",note:"模型未返回该股道",confidence:0})}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function setCompareMode(on){E.compareWorkspace.classList.toggle("has-results",on);document.querySelector(".app").classList.toggle("compare-active",on)}
function render(){E.resultBody.innerHTML="";let n=0;rows.forEach((r,i)=>{const empty=!r.time&&!r.train_number,review=r.confidence<.78||r.note||empty;if(review)n++;const tr=document.createElement("tr");if(review)tr.classList.add("review");if(empty)tr.classList.add("empty");tr.innerHTML=`<td>${r.track}<span class="confidence">${Math.round(r.confidence*100)}%</span></td><td><input data-i="${i}" data-k="time" value="${esc(r.time)}" placeholder="--:--"></td><td><input data-i="${i}" data-k="train_number" value="${esc(r.train_number)}" placeholder="空"></td>`;E.resultBody.appendChild(tr)});E.summary.textContent=`31个股道，${n}行需要人工确认。`;E.resultCard.classList.remove("hidden");setCompareMode(true);requestAnimationFrame(()=>E.compareWorkspace.scrollIntoView({behavior:"smooth",block:"start"}))}
async function recognize(){if(!file)return;E.recognizeBtn.disabled=true;E.progress.classList.remove("hidden");status(E.status,"正在本地压缩照片……");try{const image=await compress(file);status(E.status,"大模型正在识别整张车表……");const d=await api("/recognize",{method:"POST",headers:headers(),body:JSON.stringify({image,note:""})});rows=norm(d.rows);originalRows=rows.map(r=>({...r}));render();showQuota(d.usage);status(E.status,"识别完成，请对照原照片检查黄色行。","success")}catch(e){if(e.status===401){state.setToken("");authUI(false)}status(E.status,e.message,"error")}finally{E.progress.classList.add("hidden");E.recognizeBtn.disabled=!file}}
function csvEsc(v){const s=String(v??"");return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s}
function exportCsv(){const lines=[["股道","时间","车号"],...rows.map(r=>[r.track,r.time,r.train_number])].map(x=>x.map(csvEsc).join(","));const b=new Blob(["\uFEFF"+lines.join("\n")],{type:"text/csv;charset=utf-8"}),a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=`车表_${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(a.href)}

function safeFileDate(){
  const d=new Date();
  const pad=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}
async function saveLearning(){
  const corrections=[];
  for(let i=0;i<rows.length;i++){
    const before=originalRows[i]||{};
    const after=rows[i]||{};
    for(const field of ["time","train_number"]){
      const predicted=String(before[field]??"").trim();
      const corrected=String(after[field]??"").trim();
      if(predicted!==corrected){
        corrections.push({
          track:Number(after.track),
          field,
          predicted,
          corrected
        });
      }
    }
  }
  if(!corrections.length) return {saved:0,total:0};
  return await api("/learn",{
    method:"POST",
    headers:headers(),
    body:JSON.stringify({corrections})
  });
}
async function exportXlsx(){
  if(!rows.length){
    status(E.status,"当前没有可导出的识别结果。","error");
    return;
  }
  if(typeof XLSX==="undefined"){
    status(E.status,"Excel 组件尚未加载，请检查网络后刷新页面。","error");
    return;
  }

  const hasUnfilled=rows.some(r=>!String(r.time||"").trim()&&!String(r.train_number||"").trim());
  const message=hasUnfilled
    ?"仍有时间和车号同时为空的行。确认这些确实为空，并保存学习、下载 XLSX 吗？"
    :"确认已经对照原照片核对完毕，并保存本次修正、下载 XLSX 吗？";
  if(!window.confirm(message)) return;

  E.xlsxBtn.disabled=true;
  status(E.status,"正在把人工修正保存到云端纠错记忆……");
  let learnMessage="";
  try{
    const learned=await saveLearning();
    const saved=Number(learned.saved||0);
    learnMessage=saved>0?`已保存 ${saved} 条纠错记忆。`:"本次没有需要保存的修正。";
    originalRows=rows.map(r=>({...r}));
  }catch(e){
    const proceed=window.confirm(`纠错记忆保存失败：${e.message}\n\n是否仍然下载 XLSX？`);
    if(!proceed){
      status(E.status,"已取消下载，请检查网络后重试。","error");
      E.xlsxBtn.disabled=false;
      return;
    }
    learnMessage="纠错记忆保存失败，但已继续导出。";
  }

  const data=[
    ["股道","时间","车号"],
    ...rows.map(r=>[
      Number(r.track),
      String(r.time||"").trim(),
      String(r.train_number||"").trim()
    ])
  ];
  const ws=XLSX.utils.aoa_to_sheet(data);
  ws["!cols"]=[{wch:10},{wch:14},{wch:18}];
  ws["!autofilter"]={ref:`A1:C${data.length}`};
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,"车表");
  XLSX.writeFile(wb,`车表_${safeFileDate()}.xlsx`,{bookType:"xlsx",compression:true});
  status(E.status,`${learnMessage} XLSX 已开始下载。`,"success");
  E.xlsxBtn.disabled=false;
}

E.settingsBtn.onclick=()=>E.settingsPanel.classList.toggle("hidden");E.closeSettings.onclick=()=>E.settingsPanel.classList.add("hidden");
E.saveWorker.onclick=()=>{localStorage.setItem("ts_worker",E.workerUrl.value.trim().replace(/\/+$/,""));check()};
E.logoutBtn.onclick=()=>{state.setToken("");authUI(false);status(E.authStatus,"本机令牌已删除。","success")};
E.authorizeBtn.onclick=authorize;
E.imageInput.onchange=()=>{const f=E.imageInput.files?.[0];if(!f)return;if(!/^image\/(jpeg|png|webp)$/.test(f.type)){status(E.status,"只支持 JPG、PNG 或 WebP。","error");return}if(f.size>12*1024*1024){status(E.status,"原图不能超过12MB。","error");return}file=f;E.preview.src=URL.createObjectURL(f);E.previewWrap.classList.remove("hidden");E.recognizeBtn.disabled=false;status(E.status,"照片已选择。")};
E.removeImage.onclick=resetImage;E.recognizeBtn.onclick=recognize;
E.resultBody.oninput=e=>{const x=e.target.closest("input[data-i]");if(x)rows[Number(x.dataset.i)][x.dataset.k]=x.value.trim()};
E.clearResult.onclick=()=>{rows=[];originalRows=[];E.resultCard.classList.add("hidden");setCompareMode(false)};
E.copyBtn.onclick=async()=>{const t=[["股道","时间","车号"],...rows.map(r=>[r.track,r.time,r.train_number])].map(x=>x.join("\t")).join("\n");try{await navigator.clipboard.writeText(t);status(E.status,"已复制，可粘贴到WPS或Excel。","success")}catch{status(E.status,"复制失败，请导出CSV。","error")}};
E.csvBtn.onclick=exportCsv;
E.xlsxBtn.onclick=exportXlsx;
E.workerUrl.value=state.base;authUI(!!state.token);check();
if("serviceWorker"in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
