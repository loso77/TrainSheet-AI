/* TrainSheet AI Version: 0.9.2 */
const $=id=>document.getElementById(id);
const cameraInput=$("cameraInput"),galleryInput=$("galleryInput"),previewCard=$("previewCard"),previewImage=$("previewImage"),overlayCanvas=$("overlayCanvas"),startBtn=$("startBtn"),clearBtn=$("clearBtn"),statusText=$("statusText"),workflowState=$("workflowState"),anchorCount=$("anchorCount"),anchorScore=$("anchorScore"),progressWrap=$("progressWrap"),progressBar=$("progressBar"),anchorPanel=$("anchorPanel"),anchorChips=$("anchorChips"),rangeBadge=$("rangeBadge"),targetPanel=$("targetPanel"),targetCanvas=$("targetCanvas"),targetBadge=$("targetBadge"),rowsPanel=$("rowsPanel"),rowsCanvas=$("rowsCanvas"),fallbackPanel=$("fallbackPanel"),debugPanel=$("debugPanel"),debugText=$("debugText");
let currentImage=null,currentImageUrl=null,worker=null,lastResult=null;
const OCR_MAX_WIDTH=2200;
const MIN_ANCHORS=3;

cameraInput.addEventListener("change",()=>handleImage(cameraInput.files[0]));
galleryInput.addEventListener("change",()=>handleImage(galleryInput.files[0]));
clearBtn.addEventListener("click",clearAll);
startBtn.addEventListener("click",runAnchorRecognition);

function handleImage(file){
  if(!file)return;
  if(currentImageUrl)URL.revokeObjectURL(currentImageUrl);
  currentImageUrl=URL.createObjectURL(file);
  const img=new Image();
  img.onload=()=>{
    currentImage=img;previewImage.src=currentImageUrl;previewCard.classList.remove("hidden");startBtn.disabled=false;resetOutput();
    statusText.textContent="照片已载入。V0.9.2 会分区域、分阈值扫描印刷编号。";
  };
  img.src=currentImageUrl;
}

function clearAll(){
  if(currentImageUrl)URL.revokeObjectURL(currentImageUrl);
  currentImageUrl=null;currentImage=null;lastResult=null;previewImage.src="";previewCard.classList.add("hidden");startBtn.disabled=true;
  resetOutput();statusText.textContent="请先拍照或从相册选择一张完整图片。";
}

function resetOutput(){
  clearSteps();workflowState.textContent="等待处理";anchorCount.textContent="0";anchorScore.textContent="0";progressWrap.classList.add("hidden");progressBar.style.width="0%";
  anchorPanel.classList.add("hidden");targetPanel.classList.add("hidden");rowsPanel.classList.add("hidden");fallbackPanel.classList.add("hidden");debugPanel.classList.add("hidden");
  const ctx=overlayCanvas.getContext("2d");ctx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
}

async function runAnchorRecognition(){
  if(!currentImage)return;
  startBtn.disabled=true;resetOutput();progressWrap.classList.remove("hidden");
  try{
    let sources=[];
    await runStep("photo","正在生成多组增强图……",async()=>{sources=buildOCRSources(currentImage)});
    await runStep("ocr","正在分区域运行本地 OCR……",async()=>{
      const w=await getWorker();
      const allWords=[];const passes=[];
      for(let i=0;i<sources.length;i++){
        const src=sources[i];
        statusText.textContent=`OCR 扫描 ${i+1}/${sources.length}：${src.name}`;
        await w.setParameters({tessedit_char_whitelist:"0123456789",tessedit_pageseg_mode:src.psm,preserve_interword_spaces:"1",user_defined_dpi:"300"});
        const res=await w.recognize(src.canvas,{}, {text:true,tsv:true,blocks:false});
        const words=parseTSVFlexible(res.data.tsv,src);
        allWords.push(...words);passes.push({name:src.name,count:words.length,text:(res.data.text||"").slice(0,180)});
        progressBar.style.width=Math.round((i+1)/sources.length*92)+"%";
      }
      lastResult={words:dedupeWords(allWords),passes};
    });
    await runStep("anchor","正在寻找连续的 31～61……",async()=>{
      lastResult.sequence=findBestAnchorSequence(lastResult.words,currentImage.naturalWidth,currentImage.naturalHeight);
    });
    const seq=lastResult.sequence;
    if(!seq||seq.anchors.length<MIN_ANCHORS||seq.score<34){markFail("anchor");showFallback(seq,lastResult);return;}
    await runStep("fit","正在拟合编号列的倾斜方向……",async()=>{lastResult.geometry=buildTargetGeometry(seq,currentImage)});
    await runStep("crop","正在拉直并裁出目标区……",async()=>{drawAnchorOverlay(seq,lastResult.geometry);drawRectifiedTarget(lastResult.geometry,targetCanvas,false);drawRectifiedTarget(lastResult.geometry,rowsCanvas,true)});
    showSuccess(seq,lastResult.geometry,lastResult);
  }catch(err){
    console.error(err);fallbackPanel.classList.remove("hidden");debugPanel.classList.remove("hidden");debugText.textContent=String(err&&err.stack?err.stack:err);
    statusText.textContent="本地 OCR 运行失败。请刷新后重试，并把调试信息截图发给我。";workflowState.textContent="处理失败";
  }finally{startBtn.disabled=false;}
}

async function getWorker(){
  if(worker)return worker;if(!window.Tesseract)throw new Error("Tesseract.js 未加载");
  worker=await Tesseract.createWorker("eng",1,{workerPath:"./worker.min.js",corePath:"./",langPath:"./",gzip:true,
    logger:m=>{if(typeof m.progress==="number"){const pct=Math.max(2,Math.min(90,Math.round(m.progress*90)));progressBar.style.width=pct+"%";if(m.status)statusText.textContent="OCR："+translateStatus(m.status)+" "+pct+"%";}},errorHandler:e=>console.error("OCR worker",e)});
  return worker;
}
function translateStatus(s){const map={"loading tesseract core":"载入识别引擎","initializing tesseract":"初始化识别引擎","loading language traineddata":"载入数字模型","initializing api":"初始化接口","recognizing text":"识别印刷编号"};return map[s]||s}

function buildOCRSources(img){
  const defs=[
    {name:"右侧70%·高对比",left:.30,width:.70,mode:"threshold",psm:"11"},
    {name:"右侧45%·放大",left:.52,width:.48,mode:"adaptive",psm:"11"},
    {name:"中右竖条·印刷编号",left:.45,width:.28,mode:"threshold",psm:"6"},
    {name:"整图·灰度补扫",left:0,width:1,mode:"gray",psm:"11"}
  ];
  return defs.map(d=>makeSource(img,d));
}
function makeSource(img,d){
  const cropX=img.naturalWidth*d.left,cropW=img.naturalWidth*d.width;
  const scale=Math.min(2.2,OCR_MAX_WIDTH/cropW);const outW=Math.max(1,Math.round(cropW*scale)),outH=Math.max(1,Math.round(img.naturalHeight*scale));
  const c=document.createElement("canvas"),ctx=c.getContext("2d",{willReadFrequently:true});c.width=outW;c.height=outH;ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
  ctx.drawImage(img,cropX,0,cropW,img.naturalHeight,0,0,outW,outH);
  const im=ctx.getImageData(0,0,outW,outH),px=im.data;
  for(let i=0;i<px.length;i+=4){const g=Math.round(.299*px[i]+.587*px[i+1]+.114*px[i+2]);let v=g;if(d.mode==="threshold")v=g<190?0:255;else if(d.mode==="adaptive")v=g<165?0:(g<205?Math.max(0,(g-165)*6):255);else v=Math.max(0,Math.min(255,(g-128)*1.45+128));px[i]=px[i+1]=px[i+2]=v;}
  ctx.putImageData(im,0,0);return{canvas:c,scale,cropX,name:d.name,psm:d.psm};
}

function parseTSVFlexible(tsv,src){
  if(!tsv)return[];const lines=tsv.trim().split(/\r?\n/);if(lines.length<2)return[];const headers=lines[0].split("\t"),idx={};headers.forEach((h,i)=>idx[h]=i);const words=[];
  for(let n=1;n<lines.length;n++){
    const p=lines[n].split("\t");if(p[idx.level]!=="5")continue;
    const raw=(p[idx.text]||"").replace(/[OoQD]/g,"0").replace(/[Il|]/g,"1").replace(/[^0-9]/g,"");if(raw.length<2)continue;
    const left=Number(p[idx.left]),top=Number(p[idx.top]),width=Number(p[idx.width]),height=Number(p[idx.height]),conf=Number(p[idx.conf]);if(!Number.isFinite(left+top+width+height))continue;
    const matches=[];
    if(/^\d{2}$/.test(raw)){const v=Number(raw);if(v>=31&&v<=61)matches.push({value:v,pos:.5});}
    else{
      for(let k=0;k<raw.length-1;k++){const v=Number(raw.slice(k,k+2));if(v>=31&&v<=61)matches.push({value:v,pos:(k+1)/raw.length});}
    }
    for(const m of matches){const cxLocal=left+Math.max(0,Math.min(width,width*m.pos));words.push({value:m.value,text:String(m.value),conf:Math.max(0,conf-raw.length*2),x0:(left+src.cropX*src.scale)/src.scale,y0:top/src.scale,x1:(left+width+src.cropX*src.scale)/src.scale,y1:(top+height)/src.scale,cx:(cxLocal+src.cropX*src.scale)/src.scale,cy:(top+height/2)/src.scale,source:src.name,raw});}
  }
  return words;
}
function dedupeWords(words){const out=[];words.sort((a,b)=>b.conf-a.conf);for(const w of words){if(out.some(o=>o.value===w.value&&Math.hypot(o.cx-w.cx,o.cy-w.cy)<Math.max(18,w.y1-w.y0)*1.5))continue;out.push(w)}return out}

function findBestAnchorSequence(words,W,H){
  if(words.length<2)return null;let best=null;const xTolerance=Math.max(45,W*.10);
  for(const seed of words){const group=words.filter(w=>Math.abs(w.cx-seed.cx)<xTolerance).sort((a,b)=>a.cy-b.cy);if(group.length<2)continue;const clean=bestMonotonicSubset(group);if(clean.length<2)continue;
    const model=linearFit(clean.map(w=>w.value),clean.map(w=>w.cy)),xModel=linearFit(clean.map(w=>w.cy),clean.map(w=>w.cx));const residual=Math.sqrt(clean.reduce((s,w)=>s+Math.pow(w.cy-(model.a*w.value+model.b),2),0)/clean.length);const rowStep=Math.abs(model.a);const range=Math.max(...clean.map(w=>w.value))-Math.min(...clean.map(w=>w.value));const confidence=clean.reduce((s,w)=>s+Math.max(0,w.conf),0)/clean.length;const rightBonus=clean.reduce((s,w)=>s+w.cx,0)/clean.length>W*.50?14:0;const coverage=Math.min(31,range+1)/31;const regularity=rowStep>3?Math.max(0,1-residual/(rowStep*1.8)):0;const score=clean.length*8+coverage*28+regularity*24+rightBonus+Math.min(10,confidence/10);const candidate={anchors:clean,model,xModel,rowStep,residual,score,range,confidence};if(!best||candidate.score>best.score)best=candidate;
  }return best;
}
function bestMonotonicSubset(group){const sorted=[...group].sort((a,b)=>a.cy-b.cy),dp=sorted.map(()=>({len:1,score:0,prev:-1}));let bestI=0;for(let i=0;i<sorted.length;i++){for(let j=0;j<i;j++){const dv=sorted[i].value-sorted[j].value,dy=sorted[i].cy-sorted[j].cy;if(dv<=0||dv>15||dy<=0)continue;const ratio=dy/dv;if(ratio<2||ratio>220)continue;const add=1+Math.min(2,dv/5);if(dp[j].len+1>dp[i].len||(dp[j].len+1===dp[i].len&&dp[j].score+add>dp[i].score))dp[i]={len:dp[j].len+1,score:dp[j].score+add,prev:j}}if(dp[i].len>dp[bestI].len||(dp[i].len===dp[bestI].len&&dp[i].score>dp[bestI].score))bestI=i}const result=[];let k=bestI;while(k>=0){result.push(sorted[k]);k=dp[k].prev}return result.reverse()}
function linearFit(xs,ys){const n=xs.length,mx=xs.reduce((a,b)=>a+b,0)/n,my=ys.reduce((a,b)=>a+b,0)/n;let num=0,den=0;for(let i=0;i<n;i++){num+=(xs[i]-mx)*(ys[i]-my);den+=(xs[i]-mx)*(xs[i]-mx)}const a=den?num/den:0,b=my-a*mx;return{a,b}}

function buildTargetGeometry(seq,img){const y31=seq.model.a*31+seq.model.b,y61=seq.model.a*61+seq.model.b,rowH=Math.max(8,Math.abs(seq.model.a));const topY=Math.max(0,Math.min(y31,y61)-rowH*.72),bottomY=Math.min(img.naturalHeight,Math.max(y31,y61)+rowH*.72);const anchorX=y=>seq.xModel.a*y+seq.xModel.b;const width=estimateTargetWidth(img,anchorX,topY,bottomY,rowH);const leftOffset=Math.max(rowH*.9,width*.06);const topLeftX=Math.max(0,anchorX(topY)-leftOffset),bottomLeftX=Math.max(0,anchorX(bottomY)-leftOffset),topRightX=Math.min(img.naturalWidth,topLeftX+width),bottomRightX=Math.min(img.naturalWidth,bottomLeftX+width);return{topY,bottomY,rowH,width,topLeftX,bottomLeftX,topRightX,bottomRightX}}
function estimateTargetWidth(img,anchorX,topY,bottomY,rowH){return Math.min(img.naturalWidth*.48,Math.max(rowH*6.2,rowH*9.2))}

function drawAnchorOverlay(seq,g){const box=previewImage.getBoundingClientRect();overlayCanvas.width=box.width;overlayCanvas.height=box.height;const ctx=overlayCanvas.getContext("2d");ctx.clearRect(0,0,box.width,box.height);const sx=box.width/currentImage.naturalWidth,sy=box.height/currentImage.naturalHeight;ctx.font="bold 11px -apple-system";ctx.textAlign="center";ctx.textBaseline="middle";for(const a of seq.anchors){ctx.fillStyle="#16a34a";ctx.beginPath();ctx.arc(a.cx*sx,a.cy*sy,8,0,Math.PI*2);ctx.fill();ctx.fillStyle="#fff";ctx.fillText(String(a.value),a.cx*sx,a.cy*sy)}ctx.strokeStyle="#f59e0b";ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(g.topLeftX*sx,g.topY*sy);ctx.lineTo(g.topRightX*sx,g.topY*sy);ctx.lineTo(g.bottomRightX*sx,g.bottomY*sy);ctx.lineTo(g.bottomLeftX*sx,g.bottomY*sy);ctx.closePath();ctx.stroke()}
function drawRectifiedTarget(g,canvas,withRows){const outW=720,outH=31*46;canvas.width=outW;canvas.height=outH;const ctx=canvas.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,outW,outH);const strips=Math.min(outH,900);for(let i=0;i<strips;i++){const t=i/(strips-1),srcY=g.topY+(g.bottomY-g.topY)*t,left=g.topLeftX+(g.bottomLeftX-g.topLeftX)*t,right=g.topRightX+(g.bottomRightX-g.topRightX)*t,dstY=Math.floor(i*outH/strips),dstH=Math.ceil(outH/strips)+1;ctx.drawImage(currentImage,left,srcY,Math.max(1,right-left),Math.max(1,(g.bottomY-g.topY)/strips+1),0,dstY,outW,dstH)}if(withRows){ctx.strokeStyle="rgba(37,99,235,.8)";ctx.lineWidth=1;for(let i=0;i<=31;i++){const y=i*outH/31;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(outW,y);ctx.stroke()}ctx.fillStyle="rgba(37,99,235,.9)";ctx.font="bold 15px sans-serif";for(let i=0;i<31;i++)ctx.fillText(String(31+i),5,(i+.65)*outH/31)}}

function showSuccess(seq,g,result){const vals=seq.anchors.map(a=>a.value).sort((a,b)=>a-b);anchorCount.textContent=String(vals.length);anchorScore.textContent=String(Math.min(99,Math.round(seq.score)));anchorPanel.classList.remove("hidden");targetPanel.classList.remove("hidden");rowsPanel.classList.remove("hidden");debugPanel.classList.remove("hidden");rangeBadge.textContent=`${Math.min(...vals)}～${Math.max(...vals)}`;anchorChips.innerHTML=seq.anchors.sort((a,b)=>a.value-b.value).map(a=>`<span class="anchor-chip ${a.conf<45?'low':''}">${a.value} · ${Math.round(a.conf)}%</span>`).join("");targetBadge.textContent=`${Math.min(99,Math.round(seq.score))} 分`;debugText.textContent=JSON.stringify({passes:result.passes,candidates:result.words.length,anchors:seq.anchors.map(a=>({n:a.value,conf:Math.round(a.conf),x:Math.round(a.cx),y:Math.round(a.cy),source:a.source,raw:a.raw})),rowHeight:Math.round(g.rowH),targetWidth:Math.round(g.width),score:Math.round(seq.score),residual:Number(seq.residual.toFixed(1))},null,2);workflowState.textContent="锚点定位完成";statusText.textContent="已根据印刷编号定位目标区。请检查拉直结果是否从31完整到61。";progressBar.style.width="100%"}
function showFallback(seq,result){fallbackPanel.classList.remove("hidden");debugPanel.classList.remove("hidden");anchorCount.textContent=seq?String(seq.anchors.length):"0";anchorScore.textContent=seq?String(Math.round(seq.score)):"0";debugText.textContent=JSON.stringify({passes:result.passes,candidates:result.words.length,sequence:seq?{anchors:seq.anchors.map(a=>({n:a.value,conf:Math.round(a.conf),x:Math.round(a.cx),y:Math.round(a.cy),source:a.source,raw:a.raw})),score:Math.round(seq.score),residual:Number(seq.residual.toFixed(1))}:null},null,2);workflowState.textContent="未可靠定位";statusText.textContent="多区域 OCR 后仍未形成可靠连续编号，程序已停止，没有自行猜测。"}
async function runStep(name,text,job){workflowState.textContent=text.replace("……","");statusText.textContent=text;setStep(name,"active");await job();setStep(name,"done")}
function setStep(name,state){const el=document.querySelector(`[data-step="${name}"]`);if(!el)return;el.classList.remove("active","done","fail");if(state)el.classList.add(state)}
function markFail(name){setStep(name,"fail")}function clearSteps(){document.querySelectorAll(".step").forEach(x=>x.classList.remove("active","done","fail"))}
if("serviceWorker" in navigator){navigator.serviceWorker.register("sw.js").catch(console.error)}
