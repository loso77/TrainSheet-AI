/* TrainSheet AI Version: 0.9.4 */
const cameraInput=document.getElementById("cameraInput"),galleryInput=document.getElementById("galleryInput"),previewCard=document.getElementById("previewCard"),previewImage=document.getElementById("previewImage"),overlayCanvas=document.getElementById("overlayCanvas"),startBtn=document.getElementById("startBtn"),clearBtn=document.getElementById("clearBtn"),statusText=document.getElementById("statusText"),workflowState=document.getElementById("workflowState"),rowBoundaryCount=document.getElementById("rowBoundaryCount"),verticalCount=document.getElementById("verticalCount"),targetPanel=document.getElementById("targetPanel"),targetCanvas=document.getElementById("targetCanvas"),rowsPanel=document.getElementById("rowsPanel"),rowsCanvas=document.getElementById("rowsCanvas"),targetStatus=document.getElementById("targetStatus"),debugPanel=document.getElementById("debugPanel"),debugText=document.getElementById("debugText");
let currentImage=null,currentImageUrl=null,result=null;

function handleImage(file){
  if(!file)return;
  if(currentImageUrl)URL.revokeObjectURL(currentImageUrl);
  currentImageUrl=URL.createObjectURL(file);
  const img=new Image();
  img.onload=()=>{
    currentImage=img;
    previewImage.src=currentImageUrl;
    previewCard.classList.remove("hidden");
    startBtn.disabled=false;
    reset();
    statusText.textContent="照片已载入。程序会寻找固定的 32 条横边界，而不是识别 31～61 的文字。";
  };
  img.src=currentImageUrl;
}
cameraInput.addEventListener("change",()=>handleImage(cameraInput.files[0]));
galleryInput.addEventListener("change",()=>handleImage(galleryInput.files[0]));
clearBtn.addEventListener("click",()=>{
  if(currentImageUrl)URL.revokeObjectURL(currentImageUrl);
  currentImageUrl=null;currentImage=null;previewImage.src="";
  previewCard.classList.add("hidden");startBtn.disabled=true;reset();
  statusText.textContent="请先拍照或从相册选择一张完整图片。";
});

startBtn.addEventListener("click",async()=>{
  if(!currentImage)return;
  startBtn.disabled=true;
  reset(false);
  await step("photo","正在读取照片……");
  const working=makeWorkingCanvas(currentImage);
  await step("angle","正在估算表格倾斜角……");
  const angle=estimateAngle(working.canvas);
  const rotated=rotateCanvas(working.canvas,-angle);
  await step("rows","正在寻找固定 32 条横边界……");
  const rowInfo=findBest32Rows(rotated);
  rowBoundaryCount.textContent=String(rowInfo.rows.length);
  if(rowInfo.rows.length!==32){
    failStep("rows");
    showFailure({angle,rowInfo,message:"未找到可靠的 32 条横边界"});
    startBtn.disabled=false;
    return;
  }
  await step("cols","正在寻找右侧表格竖边界……");
  const colInfo=findRightColumns(rotated,rowInfo);
  verticalCount.textContent=String(colInfo.cols.length);
  if(colInfo.cols.length<4){
    failStep("cols");
    showFailure({angle,rowInfo,colInfo,message:"横边界已找到，但竖边界不足"});
    startBtn.disabled=false;
    return;
  }
  await step("crop","正在裁出固定 31 行目标区……");
  result={angle,rotated,rowInfo,colInfo};
  drawAll(result);
  statusText.textContent="已按固定 31 行模板裁出目标区。请检查是否从 31 一直到 61。";
  startBtn.disabled=false;
});

function makeWorkingCanvas(img){
  const maxW=1200;
  const scale=Math.min(1,maxW/img.naturalWidth);
  const canvas=document.createElement("canvas");
  canvas.width=Math.round(img.naturalWidth*scale);
  canvas.height=Math.round(img.naturalHeight*scale);
  canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
  return{canvas,scale};
}

function estimateAngle(canvas){
  const ctx=canvas.getContext("2d");
  const {width:w,height:h}=canvas;
  const img=ctx.getImageData(0,0,w,h).data;
  const candidates=[];
  for(let deg=-12;deg<=12;deg+=1){
    const rad=deg*Math.PI/180,cos=Math.cos(rad),sin=Math.sin(rad);
    let score=0;
    for(let y=Math.floor(h*.08);y<h*.94;y+=6){
      let run=0,best=0;
      for(let x=Math.floor(w*.35);x<w*.98;x+=2){
        const xx=Math.round(x*cos-y*sin+w*.5*(1-cos)+h*.5*sin);
        const yy=Math.round(x*sin+y*cos+h*.5*(1-cos)-w*.5*sin);
        if(xx<0||xx>=w||yy<0||yy>=h){run=0;continue}
        const i=(yy*w+xx)*4;
        const gray=.299*img[i]+.587*img[i+1]+.114*img[i+2];
        if(gray<120){run++;best=Math.max(best,run)}else run=0;
      }
      score+=best;
    }
    candidates.push({deg,score});
  }
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0].deg;
}

function rotateCanvas(src,deg){
  const rad=deg*Math.PI/180,cos=Math.abs(Math.cos(rad)),sin=Math.abs(Math.sin(rad));
  const w=src.width,h=src.height;
  const out=document.createElement("canvas");
  out.width=Math.ceil(w*cos+h*sin);
  out.height=Math.ceil(w*sin+h*cos);
  const ctx=out.getContext("2d");
  ctx.translate(out.width/2,out.height/2);
  ctx.rotate(rad);
  ctx.drawImage(src,-w/2,-h/2);
  return out;
}

function findBest32Rows(canvas){
  const ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height;
  const img=ctx.getImageData(0,0,w,h).data;
  const x1=Math.floor(w*.52),x2=Math.floor(w*.98);
  const score=new Array(h).fill(0);
  for(let y=Math.floor(h*.05);y<h*.96;y++){
    let dark=0;
    for(let x=x1;x<x2;x+=2){
      const i=(y*w+x)*4;
      const gray=.299*img[i]+.587*img[i+1]+.114*img[i+2];
      if(gray<135)dark++;
    }
    score[y]=dark;
  }
  const peaks=clusterPeaks(score,Math.max(12,(x2-x1)/2*.10),4);
  let best={rows:[],score:-1,spacing:0};
  for(let start=0;start<peaks.length;start++){
    for(let end=start+31;end<peaks.length;end++){
      const subset=peaks.slice(start,end+1);
      if(subset.length<32)continue;
      for(let offset=0;offset<=subset.length-32;offset++){
        const rows=subset.slice(offset,offset+32);
        const gaps=[];
        for(let i=1;i<rows.length;i++)gaps.push(rows[i]-rows[i-1]);
        const med=median(gaps);
        if(med<4||med>h*.06)continue;
        const regular=gaps.filter(g=>Math.abs(g-med)/med<.35).length/gaps.length;
        const span=rows[31]-rows[0];
        const spanScore=(span>h*.22&&span<h*.88)?1:.35;
        const rightDark=averageRowDarkness(score,rows);
        const total=regular*65+spanScore*20+Math.min(15,rightDark/10);
        if(total>best.score)best={rows,score:total,spacing:med,regular};
      }
    }
  }
  return best;
}

function findRightColumns(canvas,rowInfo){
  const ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height;
  const img=ctx.getImageData(0,0,w,h).data;
  const y1=Math.max(0,Math.floor(rowInfo.rows[0]-2)),y2=Math.min(h-1,Math.ceil(rowInfo.rows[31]+2));
  const score=new Array(w).fill(0);
  for(let x=Math.floor(w*.45);x<w*.99;x++){
    let dark=0;
    for(let y=y1;y<=y2;y+=2){
      const i=(y*w+x)*4;
      const gray=.299*img[i]+.587*img[i+1]+.114*img[i+2];
      if(gray<135)dark++;
    }
    score[x]=dark;
  }
  const peaks=clusterPeaks(score,Math.max(8,(y2-y1)/2*.10),4);
  const candidates=peaks.filter(x=>x>w*.48);
  let best={cols:[],score:-1};
  for(let i=0;i<candidates.length;i++){
    for(let j=i+3;j<candidates.length;j++){
      const cols=candidates.slice(i,j+1);
      if(cols.length<4||cols.length>7)continue;
      const width=cols[cols.length-1]-cols[0];
      if(width<w*.12||width>w*.48)continue;
      const gaps=[];for(let k=1;k<cols.length;k++)gaps.push(cols[k]-cols[k-1]);
      const narrowWidePattern=columnPatternScore(gaps);
      const rightScore=cols[0]>w*.55?25:12;
      const countScore=cols.length===5?35:cols.length===4||cols.length===6?24:12;
      const total=narrowWidePattern*40+rightScore+countScore;
      if(total>best.score)best={cols,score:total,gaps};
    }
  }
  if(best.cols.length>5){
    best.cols=best.cols.slice(-5);
  }
  return best;
}

function columnPatternScore(gaps){
  if(gaps.length<3)return 0;
  const sorted=[...gaps].sort((a,b)=>a-b);
  const min=sorted[0],max=sorted[sorted.length-1];
  if(min<=0)return 0;
  const ratio=max/min;
  return Math.max(0,1-Math.abs(ratio-2.2)/2.2);
}

function clusterPeaks(score,threshold,gap){
  const raw=[];let start=-1,sum=0,count=0,maxVal=0,maxIdx=0;
  for(let i=0;i<score.length;i++){
    if(score[i]>=threshold){
      if(start<0){start=i;sum=0;count=0;maxVal=0;maxIdx=i}
      sum+=i;count++;
      if(score[i]>maxVal){maxVal=score[i];maxIdx=i}
    }else if(start>=0){
      raw.push(maxIdx);start=-1;
    }
  }
  if(start>=0)raw.push(maxIdx);
  const out=[];
  raw.forEach(v=>{
    if(!out.length||v-out[out.length-1]>=gap)out.push(v);
    else out[out.length-1]=Math.round((out[out.length-1]+v)/2);
  });
  return out;
}

function median(a){const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]}
function averageRowDarkness(score,rows){return rows.reduce((s,y)=>s+(score[Math.round(y)]||0),0)/rows.length}

function drawAll(res){
  drawOverlay(res);
  drawTargetCrop(res);
  drawRowsPreview(res);
  targetPanel.classList.remove("hidden");
  rowsPanel.classList.remove("hidden");
  debugPanel.classList.remove("hidden");
  targetStatus.textContent="31 行模板已锁定";
  debugText.textContent=JSON.stringify({
    angle:res.angle,
    rowBoundaries:res.rowInfo.rows.length,
    rowSpacing:Math.round(res.rowInfo.spacing*10)/10,
    rowRegularity:Math.round((res.rowInfo.regular||0)*100)+"%",
    verticalBoundaries:res.colInfo.cols.length,
    verticalScore:Math.round(res.colInfo.score)
  },null,2);
}

function drawOverlay(res){
  const box=previewImage.getBoundingClientRect();
  overlayCanvas.width=box.width;overlayCanvas.height=box.height;
  const ctx=overlayCanvas.getContext("2d");
  ctx.clearRect(0,0,box.width,box.height);
  const sx=box.width/res.rotated.width,sy=box.height/res.rotated.height;
  ctx.strokeStyle="rgba(37,99,235,.85)";ctx.lineWidth=1.2;
  res.rowInfo.rows.forEach(y=>{ctx.beginPath();ctx.moveTo(0,y*sy);ctx.lineTo(box.width,y*sy);ctx.stroke()});
  ctx.strokeStyle="rgba(22,163,74,.9)";ctx.lineWidth=1.8;
  res.colInfo.cols.forEach(x=>{ctx.beginPath();ctx.moveTo(x*sx,0);ctx.lineTo(x*sx,box.height);ctx.stroke()});
  const x1=res.colInfo.cols[0],x2=res.colInfo.cols[res.colInfo.cols.length-1],y1=res.rowInfo.rows[0],y2=res.rowInfo.rows[31];
  ctx.strokeStyle="#f59e0b";ctx.lineWidth=5;ctx.strokeRect(x1*sx,y1*sy,(x2-x1)*sx,(y2-y1)*sy);
}

function drawTargetCrop(res){
  const x1=res.colInfo.cols[0],x2=res.colInfo.cols[res.colInfo.cols.length-1],y1=res.rowInfo.rows[0],y2=res.rowInfo.rows[31];
  const w=x2-x1,h=y2-y1;
  targetCanvas.width=520;targetCanvas.height=Math.max(420,Math.round(520*h/w));
  const ctx=targetCanvas.getContext("2d");
  ctx.drawImage(res.rotated,x1,y1,w,h,0,0,targetCanvas.width,targetCanvas.height);
  ctx.strokeStyle="#f59e0b";ctx.lineWidth=6;ctx.strokeRect(3,3,targetCanvas.width-6,targetCanvas.height-6);
}

function drawRowsPreview(res){
  const x1=res.colInfo.cols[0],x2=res.colInfo.cols[res.colInfo.cols.length-1],y1=res.rowInfo.rows[0],y2=res.rowInfo.rows[31];
  const w=x2-x1,h=y2-y1;
  rowsCanvas.width=520;rowsCanvas.height=Math.max(520,Math.round(520*h/w));
  const ctx=rowsCanvas.getContext("2d");
  ctx.drawImage(res.rotated,x1,y1,w,h,0,0,rowsCanvas.width,rowsCanvas.height);
  ctx.font="bold 14px -apple-system";ctx.textBaseline="middle";
  for(let i=0;i<=31;i++){
    const y=(res.rowInfo.rows[i]-y1)/h*rowsCanvas.height;
    ctx.strokeStyle="rgba(37,99,235,.9)";ctx.lineWidth=1.2;
    ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(rowsCanvas.width,y);ctx.stroke();
    if(i<31){
      const yNext=(res.rowInfo.rows[i+1]-y1)/h*rowsCanvas.height;
      ctx.fillStyle="rgba(245,158,11,.95)";
      ctx.fillRect(0,y,38,yNext-y);
      ctx.fillStyle="#111827";
      ctx.fillText(String(31+i),8,(y+yNext)/2);
    }
  }
  ctx.strokeStyle="#f59e0b";ctx.lineWidth=6;ctx.strokeRect(3,3,rowsCanvas.width-6,rowsCanvas.height-6);
}

function showFailure(info){
  targetPanel.classList.add("hidden");rowsPanel.classList.add("hidden");
  debugPanel.classList.remove("hidden");
  debugText.textContent=JSON.stringify(info,null,2);
  statusText.textContent=info.message+"。程序已停止，没有自行猜测。";
}

function reset(clear=true){
  clearSteps();workflowState.textContent="等待处理";
  rowBoundaryCount.textContent="0";verticalCount.textContent="0";
  targetPanel.classList.add("hidden");rowsPanel.classList.add("hidden");debugPanel.classList.add("hidden");
  const ctx=overlayCanvas.getContext("2d");ctx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
  if(clear)result=null;
}
function clearSteps(){document.querySelectorAll(".step").forEach(s=>s.classList.remove("active","done","fail"))}
function failStep(n){const s=document.querySelector(`[data-step="${n}"]`);if(s){s.classList.remove("active","done");s.classList.add("fail")}}
function done(n){const s=document.querySelector(`[data-step="${n}"]`);if(s){s.classList.remove("active");s.classList.add("done")}}
async function step(n,t){workflowState.textContent=t.replace("……","");statusText.textContent=t;document.querySelector(`[data-step="${n}"]`)?.classList.add("active");await new Promise(r=>setTimeout(r,260));done(n)}
if("serviceWorker"in navigator){navigator.serviceWorker.register("sw.js").catch(()=>{})}