/* TrainSheet AI Version: 0.9.5 */
const cameraInput=document.getElementById("cameraInput"),galleryInput=document.getElementById("galleryInput"),selectPanel=document.getElementById("selectPanel"),selectCanvas=document.getElementById("selectCanvas"),resetPointsBtn=document.getElementById("resetPointsBtn"),pointHint=document.getElementById("pointHint"),warpBtn=document.getElementById("warpBtn"),resultPanel=document.getElementById("resultPanel"),warpedCanvas=document.getElementById("warpedCanvas"),rowsPanel=document.getElementById("rowsPanel"),rowCanvas=document.getElementById("rowCanvas"),rowLabel=document.getElementById("rowLabel"),prevRowBtn=document.getElementById("prevRowBtn"),nextRowBtn=document.getElementById("nextRowBtn");
let image=null,imageUrl=null,points=[],displayScale=1,currentRow=0,warpedImageData=null;

function handleFile(file){
  if(!file)return;
  if(imageUrl)URL.revokeObjectURL(imageUrl);
  imageUrl=URL.createObjectURL(file);
  const img=new Image();
  img.onload=()=>{
    image=img;
    setupCanvas();
    resetPoints();
    selectPanel.classList.remove("hidden");
    resultPanel.classList.add("hidden");
    rowsPanel.classList.add("hidden");
    selectPanel.scrollIntoView({behavior:"smooth",block:"start"});
  };
  img.src=imageUrl;
}
cameraInput.addEventListener("change",()=>handleFile(cameraInput.files[0]));
galleryInput.addEventListener("change",()=>handleFile(galleryInput.files[0]));

function setupCanvas(){
  const maxWidth=1200;
  displayScale=Math.min(1,maxWidth/image.naturalWidth);
  selectCanvas.width=Math.round(image.naturalWidth*displayScale);
  selectCanvas.height=Math.round(image.naturalHeight*displayScale);
  drawSelection();
}
function drawSelection(){
  const ctx=selectCanvas.getContext("2d");
  ctx.clearRect(0,0,selectCanvas.width,selectCanvas.height);
  if(image)ctx.drawImage(image,0,0,selectCanvas.width,selectCanvas.height);
  if(points.length){
    ctx.save();
    ctx.strokeStyle="#f59e0b";
    ctx.lineWidth=4;
    ctx.setLineDash([10,6]);
    ctx.beginPath();
    ctx.moveTo(points[0].x,points[0].y);
    for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x,points[i].y);
    if(points.length===4)ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
  points.forEach((p,i)=>{
    ctx.beginPath();
    ctx.fillStyle=["#2563eb","#16a34a","#dc2626","#f59e0b"][i];
    ctx.arc(p.x,p.y,12,0,Math.PI*2);
    ctx.fill();
    ctx.fillStyle="#fff";
    ctx.font="bold 14px -apple-system";
    ctx.textAlign="center";
    ctx.textBaseline="middle";
    ctx.fillText(String(i+1),p.x,p.y);
  });
}
function canvasPoint(evt){
  const rect=selectCanvas.getBoundingClientRect();
  const touch=evt.touches?evt.touches[0]:evt;
  return{
    x:(touch.clientX-rect.left)*(selectCanvas.width/rect.width),
    y:(touch.clientY-rect.top)*(selectCanvas.height/rect.height)
  };
}
selectCanvas.addEventListener("click",evt=>{
  if(!image||points.length>=4)return;
  points.push(canvasPoint(evt));
  updateHint();
  drawSelection();
});
function updateHint(){
  const labels=["请点击目标表格的左上角。","请点击目标表格的右上角。","请点击目标表格的右下角。","请点击目标表格的左下角。"];
  if(points.length<4){
    pointHint.textContent=labels[points.length];
    warpBtn.disabled=true;
  }else{
    pointHint.textContent="四个角已选好，可以拉正。";
    warpBtn.disabled=false;
  }
}
function resetPoints(){
  points=[];
  updateHint();
  drawSelection();
}
resetPointsBtn.addEventListener("click",resetPoints);

warpBtn.addEventListener("click",()=>{
  if(points.length!==4)return;
  const srcPts=points.map(p=>({x:p.x/displayScale,y:p.y/displayScale}));
  const topW=distance(srcPts[0],srcPts[1]);
  const bottomW=distance(srcPts[3],srcPts[2]);
  const leftH=distance(srcPts[0],srcPts[3]);
  const rightH=distance(srcPts[1],srcPts[2]);
  const outW=Math.max(360,Math.round(Math.max(topW,bottomW)));
  const outH=Math.max(620,Math.round(Math.max(leftH,rightH)));
  warpedCanvas.width=outW;
  warpedCanvas.height=outH;
  warpPerspective(image,srcPts,warpedCanvas);
  overlayRows(warpedCanvas);
  warpedImageData=warpedCanvas.getContext("2d").getImageData(0,0,outW,outH);
  currentRow=0;
  drawCurrentRow();
  resultPanel.classList.remove("hidden");
  rowsPanel.classList.remove("hidden");
  resultPanel.scrollIntoView({behavior:"smooth",block:"start"});
});

function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}

function warpPerspective(img,src,canvas){
  const ctx=canvas.getContext("2d");
  const w=canvas.width,h=canvas.height;
  const off=document.createElement("canvas");
  off.width=img.naturalWidth;off.height=img.naturalHeight;
  off.getContext("2d").drawImage(img,0,0);
  const srcData=off.getContext("2d").getImageData(0,0,off.width,off.height);
  const out=ctx.createImageData(w,h);
  for(let y=0;y<h;y++){
    const v=y/(h-1);
    const lx=src[0].x+(src[3].x-src[0].x)*v;
    const ly=src[0].y+(src[3].y-src[0].y)*v;
    const rx=src[1].x+(src[2].x-src[1].x)*v;
    const ry=src[1].y+(src[2].y-src[1].y)*v;
    for(let x=0;x<w;x++){
      const u=x/(w-1);
      const sx=lx+(rx-lx)*u;
      const sy=ly+(ry-ly)*u;
      bilinearSample(srcData,off.width,off.height,sx,sy,out.data,(y*w+x)*4);
    }
  }
  ctx.putImageData(out,0,0);
}

function bilinearSample(srcData,w,h,x,y,dst,di){
  x=Math.max(0,Math.min(w-1,x));y=Math.max(0,Math.min(h-1,y));
  const x0=Math.floor(x),x1=Math.min(w-1,x0+1),y0=Math.floor(y),y1=Math.min(h-1,y0+1);
  const dx=x-x0,dy=y-y0;
  for(let c=0;c<4;c++){
    const p00=srcData.data[(y0*w+x0)*4+c],p10=srcData.data[(y0*w+x1)*4+c];
    const p01=srcData.data[(y1*w+x0)*4+c],p11=srcData.data[(y1*w+x1)*4+c];
    dst[di+c]=(p00*(1-dx)+p10*dx)*(1-dy)+(p01*(1-dx)+p11*dx)*dy;
  }
}

function overlayRows(canvas){
  const ctx=canvas.getContext("2d");
  const h=canvas.height,w=canvas.width;
  ctx.save();
  ctx.strokeStyle="rgba(37,99,235,.85)";
  ctx.lineWidth=Math.max(1,w/500);
  ctx.font=`bold ${Math.max(16,Math.round(w/32))}px -apple-system`;
  ctx.textBaseline="middle";
  for(let i=0;i<=31;i++){
    const y=i*h/31;
    ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();
    if(i<31){
      const y2=(i+1)*h/31;
      ctx.fillStyle="rgba(245,158,11,.92)";
      ctx.fillRect(0,y,Math.max(48,w*.09),y2-y);
      ctx.fillStyle="#111827";
      ctx.fillText(String(31+i),8,(y+y2)/2);
    }
  }
  ctx.restore();
}

function drawCurrentRow(){
  if(!warpedImageData)return;
  const src=warpedCanvas;
  const rowH=src.height/31;
  const y=Math.floor(currentRow*rowH);
  const h=Math.ceil(rowH);
  rowCanvas.width=src.width;
  rowCanvas.height=Math.max(120,h*3);
  const ctx=rowCanvas.getContext("2d");
  ctx.clearRect(0,0,rowCanvas.width,rowCanvas.height);
  ctx.drawImage(src,0,y,src.width,h,0,0,rowCanvas.width,rowCanvas.height);
  rowLabel.textContent=String(31+currentRow);
  prevRowBtn.disabled=currentRow===0;
  nextRowBtn.disabled=currentRow===30;
}
prevRowBtn.addEventListener("click",()=>{if(currentRow>0){currentRow--;drawCurrentRow()}});
nextRowBtn.addEventListener("click",()=>{if(currentRow<30){currentRow++;drawCurrentRow()}});

if("serviceWorker"in navigator){navigator.serviceWorker.register("sw.js").catch(()=>{})}
