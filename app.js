'use strict';

/** AgtronCam Ultra v2.0
 * - Multi-point calibration (least squares): A ~ w0 + w1*L + w2*a + w3*b + w4*L^2
 * - Modes: ground / bean (highlight rejection for beans)
 * - Gray card optimization (WB gains + optional mild CCM approximation)
 * - Quality gate (glare/WB/stability) controlling measure button
 * - Import/Export model (JSON), CSV export, ROI snapshot, PWA
 */

const els = {
  video: document.getElementById('video'),
  canvas: document.getElementById('canvas'),
  btnStart: document.getElementById('btnStart'),
  btnPause: document.getElementById('btnPause'),
  btnCalib: document.getElementById('btnCalib'),
  btnGrayCard: document.getElementById('btnGrayCard'),
  btnMeasure: document.getElementById('btnMeasure'),
  btnSave: document.getElementById('btnSave'),
  btnReset: document.getElementById('btnReset'),
  btnInstall: document.getElementById('btnInstall'),
  btnSnap: document.getElementById('btnSnap'),
  roiCircle: document.getElementById('roiCircle'),
  roiWhite: document.getElementById('roiWhite'),
  L: document.getElementById('L'),
  a: document.getElementById('a'),
  b: document.getElementById('b'),
  agtron: document.getElementById('agtron'),
  agtronBar: document.getElementById('agtronBar'),
  badge: document.getElementById('badge'),
  desc: document.getElementById('desc'),
  glare: document.getElementById('glare'),
  wbErr: document.getElementById('wbErr'),
  stability: document.getElementById('stability'),
  readyBar: document.getElementById('readyBar'),
  scheme: document.getElementById('scheme'),
  scale: document.getElementById('scale'),
  offset: document.getElementById('offset'),
  scaleVal: document.getElementById('scaleVal'),
  offsetVal: document.getElementById('offsetVal'),
  gate: document.getElementById('gate'),
  gateMsg: document.getElementById('gateMsg'),
  mode: document.getElementById('mode'),
  // multipoint
  refVal: document.getElementById('refVal'),
  capPoint: document.getElementById('capPoint'),
  fitLinear: document.getElementById('fitLinear'),
  fitPoly: document.getElementById('fitPoly'),
  clearPts: document.getElementById('clearPts'),
  ptsCount: document.getElementById('ptsCount'),
  modelInfo: document.getElementById('modelInfo'),
  // export
  btnExportCSV: document.getElementById('btnExportCSV'),
  btnExportModel: document.getElementById('btnExportModel'),
  importModel: document.getElementById('importModel')
};

let state = {
  running:false, paused:false, stream:null, ctx:null,
  width:1280, height:720,
  gains:{r:1,g:1,b:1}, ccm:[[1,0,0],[0,1,0],[0,0,1]],
  scale:1.20, offset:10.0,
  emaL:null, emaAlpha:0.2,
  scheme:'gourmet', gate:'normal', mode:'ground',
  log:[],
  calPoints:[], // {A,L,a,b}
  model:{ type:'linear', w:[0,1,0,0,0] } // w0,w1,w2,w3,w4 (w4 for L^2)
};

// Restore
(function restore(){
  try{
    const saved = JSON.parse(localStorage.getItem('agtroncam_ultra')||'{}');
    Object.assign(state, {
      gains: saved.gains||state.gains,
      ccm: saved.ccm||state.ccm,
      scale: saved.scale??state.scale,
      offset: saved.offset??state.offset,
      scheme: saved.scheme||state.scheme,
      gate: saved.gate||state.gate,
      mode: saved.mode||state.mode,
      model: saved.model||state.model,
      calPoints: saved.calPoints||[]
    });
  }catch{}
  els.scale.value = state.scale;
  els.offset.value = state.offset;
  els.scaleVal.textContent = state.scale.toFixed(2);
  els.offsetVal.textContent = state.offset.toFixed(1);
  els.scheme.value = state.scheme;
  els.gate.value = state.gate;
  els.mode.value = state.mode;
  els.ptsCount.textContent = state.calPoints.length;
  els.modelInfo.textContent = state.model?.type||'Linear';
})();

// Helpers
const clamp01 = x=> Math.max(0, Math.min(1,x));
const sRGB_to_linear = x => (x <= 0.04045) ? (x/12.92) : Math.pow((x+0.055)/1.055, 2.4);

function rgb_to_xyz(r,g,b){
  const R=sRGB_to_linear(r), G=sRGB_to_linear(g), B=sRGB_to_linear(b);
  return {
    X: R*0.4124564 + G*0.3575761 + B*0.1804375,
    Y: R*0.2126729 + G*0.7151522 + B*0.0721750,
    Z: R*0.0193339 + G*0.1191920 + B*0.9503041
  };
}
function xyz_to_lab(X,Y,Z){
  const Xn=0.95047, Yn=1.0, Zn=1.08883;
  let x=X/Xn, y=Y/Yn, z=Z/Zn;
  const eps=216/24389, kap=24389/27;
  const f=t=> (t>eps)?Math.cbrt(t):((kap*t+16)/116);
  const fx=f(x), fy=f(y), fz=f(z);
  return {L:116*fy-16, a:500*(fx-fy), b:200*(fy-fz)};
}

function categories(scheme){
  if (scheme==='commercial'){
    return [
      {name:"Very Light", min:78, color:"#fde047", desc:"Cerah ekstrem, origin tajam"},
      {name:"Light", min:68, color:"#fb923c", desc:"Asam segar, sweetness tinggi"},
      {name:"Medium-Light", min:58, color:"#f97316", desc:"Seimbang cenderung terang"},
      {name:"Medium", min:48, color:"#ea580c", desc:"Seimbang; body & sweetness stabil"},
      {name:"Medium-Dark", min:40, color:"#b45309", desc:"Body naik, roast jelas"},
      {name:"Dark", min:30, color:"#92400e", desc:"Roasty/pahit dominan"},
      {name:"Very Dark", min:-999, color:"#7c2d12", desc:"Sangat gelap, oils tinggi"}
    ];
  }
  // default gourmet
  return [
    {name:"Very Light", min:75, color:"#fde047", desc:"Cerah, sangat asam, origin menonjol"},
    {name:"Light", min:65, color:"#fb923c", desc:"Asam segar, sweetness tinggi"},
    {name:"Medium-Light", min:55, color:"#f97316", desc:"Seimbang ke arah terang"},
    {name:"Medium", min:45, color:"#ea580c", desc:"Seimbang; body & sweetness stabil"},
    {name:"Medium-Dark", min:35, color:"#b45309", desc:"Body meningkat, roast muncul"},
    {name:"Dark", min:25, color:"#92400e", desc:"Roasty/pahit dominan"},
    {name:"Very Dark", min:-999, color:"#7c2d12", desc:"Sangat gelap, oils tinggi"}
  ];
}
function categoryFromAgtron(A,scheme){
  const C = categories(scheme);
  for (const k of C) if (A>=k.min) return k;
  return C[C.length-1];
}

function setBadge(cat){
  els.badge.textContent = cat.name;
  els.badge.style.background = cat.color;
  els.badge.style.color = "#000";
  els.desc.textContent = cat.desc;
}

function layoutROIs(){
  const vid = els.video;
  const rect = vid.getBoundingClientRect();
  const W=rect.width, H=rect.height;
  const rad = Math.min(W,H)*0.28;
  const cx=rect.left + W/2, cy=rect.top + H/2;
  Object.assign(els.roiCircle.style, { left:(cx-rad)+"px", top:(cy-rad)+"px", width:(rad*2)+"px", height:(rad*2)+"px" });
  const ww=Math.min(W,H)*0.18, wh=ww*0.7, pad=10;
  Object.assign(els.roiWhite.style, { left:(rect.left+W-ww-pad)+"px", top:(rect.top+pad)+"px", width:ww+"px", height:wh+"px" });
}

function glarePercent(data){
  let hot=0, tot=data.length/4;
  for (let i=0;i<data.length;i+=4){
    const mx = Math.max(data[i], data[i+1], data[i+2]);
    if (mx>=250) hot++;
  }
  return 100*hot/tot;
}

function updateEMA(L){
  state.emaL = (state.emaL==null)? L : (state.emaAlpha*L + (1-state.emaAlpha)*state.emaL);
  return state.emaL;
}

function getImageDataFromElem(elem){
  const r=elem.getBoundingClientRect(), v=els.video.getBoundingClientRect();
  const sx=state.width/v.width, sy=state.height/v.height;
  const x=Math.max(0, Math.round((r.left - v.left)*sx));
  const y=Math.max(0, Math.round((r.top - v.top)*sy));
  const w=Math.max(1, Math.round(r.width*sx));
  const h=Math.max(1, Math.round(r.height*sy));
  return state.ctx.getImageData(x,y,w,h);
}

function iterCirclePixels(img, step=3){
  const {width:w, height:h, data} = img;
  const cx=Math.floor(w/2), cy=Math.floor(h/2), R=Math.min(cx,cy);
  const out=[];
  for (let y=0;y<h;y+=step){
    for (let x=0;x<w;x+=step){
      const dx=x-cx, dy=y-cy;
      if (dx*dx+dy*dy<=R*R){
        const i=(y*w+x)*4;
        out.push([data[i],data[i+1],data[i+2]]);
      }
    }
  }
  return out;
}
function iterRectPixels(img, step=2){
  const {width:w, height:h, data}=img;
  const out=[];
  for (let y=0;y<h;y+=step){
    for (let x=0;x<w;x+=step){
      const i=(y*w+x)*4;
      out.push([data[i],data[i+1],data[i+2]]);
    }
  }
  return out;
}

// WB & Gray-card
function calibrateWhite(){
  const img=getImageDataFromElem(els.roiWhite);
  const pts=iterRectPixels(img,4);
  let r=0,g=0,b=0;
  for (const p of pts){ r+=p[0]; g+=p[1]; b+=p[2]; }
  const n=pts.length||1;
  r/=n; g/=n; b/=n;
  const avg=(r+g+b)/3;
  state.gains={ r:(avg/(r||1)), g:(avg/(g||1)), b:(avg/(b||1)) };
  return {r,g,b,avg};
}

// Gray card optimize: target neutral (R=G=B)
function optimizeGray(){
  const img=getImageDataFromElem(els.roiWhite);
  const pts=iterRectPixels(img,3);
  let r=0,g=0,b=0; for (const p of pts){ r+=p[0]; g+=p[1]; b+=p[2]; }
  const n=pts.length||1; r/=n; g/=n; b/=n;
  // compute gains to make r,g,b equal to mean
  const avg=(r+g+b)/3;
  state.gains={ r:(avg/(r||1)), g:(avg/(g||1)), b:(avg/(b||1)) };
  // optional mild CCM: diagonal dominant (kept simple for stability)
  state.ccm=[[1,0,0],[0,1,0],[0,0,1]]; // placeholder (can be extended)
  return {r,g,b,avg};
}

// Regression helpers
function fitLeastSquares(X, y, lambda=0){
  // X: n x d, y: n
  const n=X.length, d=X[0].length;
  // compute XtX and Xty
  const XtX = Array.from({length:d},()=> Array(d).fill(0));
  const Xty = Array(d).fill(0);
  for (let i=0;i<n;i++){
    const xi=X[i];
    for (let a=0;a<d;a++){
      Xty[a]+= xi[a]*y[i];
      for (let b=0;b<d;b++){
        XtX[a][b]+= xi[a]*xi[b];
      }
    }
  }
  for (let a=0;a<d;a++) XtX[a][a]+=lambda; // ridge
  // solve XtX w = Xty (Gaussian elimination)
  for (let i=0;i<d;i++){ XtX[i].push(Xty[i]); }
  // forward elimination
  for (let i=0;i<d;i++){
    // pivot
    let piv=i;
    for (let r=i+1;r<d;r++) if (Math.abs(XtX[r][i])>Math.abs(XtX[piv][i])) piv=r;
    if (piv!==i){ const tmp=XtX[i]; XtX[i]=XtX[piv]; XtX[piv]=tmp; }
    const diag = XtX[i][i]||1e-9;
    for (let j=i;j<=d;j++) XtX[i][j]/=diag;
    for (let r=0;r<d;r++){
      if (r===i) continue;
      const f=XtX[r][i];
      for (let j=i;j<=d;j++) XtX[r][j]-=f*XtX[i][j];
    }
  }
  const w = XtX.map(row=> row[d]);
  return w;
}

function predictAgtron(L,a,b){
  // model priority: multipoint model if present, else linear scale/offset
  if (state.model && state.model.type){
    const t=state.model.type;
    if (t==='linear'){
      const [w0,w1]=state.model.w;
      return w0 + w1*L;
    } else if (t==='poly'){
      const [w0,w1,w2,w3,w4]=state.model.w;
      return w0 + w1*L + w2*a + w3*b + w4*(L*L);
    }
  }
  return state.scale * L + state.offset;
}

function analyzeOnce(){
  const {videoWidth:vw, videoHeight:vh} = els.video;
  if (!vw||!vh) return null;
  state.width=vw; state.height=vh;
  els.canvas.width=vw; els.canvas.height=vh;
  if (!state.ctx) state.ctx = els.canvas.getContext('2d', { willReadFrequently:true });
  state.ctx.drawImage(els.video,0,0,vw,vh);

  const sampleImg=getImageDataFromElem(els.roiCircle);
  const whiteImg=getImageDataFromElem(els.roiWhite);
  // quality signals
  const glare=glarePercent(sampleImg.data);
  els.glare.textContent=glare.toFixed(1);
  const wpts=iterRectPixels(whiteImg,6);
  let wr=0,wg=0,wb=0; for (const p of wpts){ wr+=p[0]; wg+=p[1]; wb+=p[2]; }
  const wn=wpts.length||1; wr/=wn; wg/=wn; wb/=wn;
  const wavg=(wr+wg+wb)/3;
  const wbErr=[wr,wg,wb].map(v=> (v-wavg)).map(v=>v.toFixed(1)).join(", ");
  els.wbErr.textContent=wbErr;

  // sample pixels
  let pts = iterCirclePixels(sampleImg, 3);
  // apply WB gains + optional highlight reject for beans
  const g=state.gains;
  // compute brightness for reject
  if (state.mode==='bean' && pts.length>30){
    const br = pts.map(p => Math.max(p[0],p[1],p[2]));
    br.sort((a,b)=>a-b);
    const cut = br[Math.floor(br.length*0.90)];
    pts = pts.filter(p => Math.max(p[0],p[1],p[2]) <= cut);
  }
  let sumL=0,suma=0,sumb=0,cnt=0;
  for (const p of pts){
    let R=clamp01((p[0]*g.r)/255), G=clamp01((p[1]*g.g)/255), B=clamp01((p[2]*g.b)/255);
    // mild CCM (currently identity; kept for future extension)
    const RR=R*state.ccm[0][0] + G*state.ccm[0][1] + B*state.ccm[0][2];
    const GG=R*state.ccm[1][0] + G*state.ccm[1][1] + B*state.ccm[1][2];
    const BB=R*state.ccm[2][0] + G*state.ccm[2][1] + B*state.ccm[2][2];
    const {X,Y,Z}=rgb_to_xyz(RR,GG,BB);
    const lab=xyz_to_lab(X,Y,Z);
    sumL+=lab.L; suma+=lab.a; sumb+=lab.b; cnt++;
  }
  if (cnt===0) return null;
  const L=sumL/cnt, a=suma/cnt, b=sumb/cnt;
  els.L.textContent=L.toFixed(1);
  els.a.textContent=a.toFixed(1);
  els.b.textContent=b.toFixed(1);

  const ema=updateEMA(L);
  els.stability.textContent = ema ? Math.abs(ema-L).toFixed(2) : "--";

  const A=predictAgtron(L,a,b);
  els.agtron.textContent=A.toFixed(1);
  els.agtronBar.style.width = Math.max(0, Math.min(100, ((A+5)/90)*100)) + "%";
  const cat=categoryFromAgtron(A, els.scheme.value);
  setBadge(cat);

  // Ready score
  const maxDev = Math.max(Math.abs(wr-wavg), Math.abs(wg-wavg), Math.abs(wb-wavg));
  let score=100; score -= Math.min(50, glare*5); score -= Math.min(30, maxDev*1.2);
  if (state.emaL!=null) score -= Math.min(20, Math.abs(state.emaL-L)*6);
  score=Math.max(0,Math.min(100,score));
  els.readyBar.style.width = score + "%";

  return {L,a,b,A, glare, wbDev:maxDev, score};
}

function measureAveraged(frames=28, delayMs=18){
  // quality gate
  const gate=els.gate.value;
  const glareMax = gate==='strict'?2.0 : gate==='normal'?3.0 : 5.0;
  const wbMax    = gate==='strict'?6.0 : gate==='normal'?9.0 : 14.0;
  const stabMax  = gate==='strict'?0.6 : gate==='normal'?0.9 : 1.2;

  const qLast = analyzeOnce();
  if (!qLast){ alert("Kamera belum aktif."); return; }
  if (parseFloat(els.glare.textContent) > glareMax){ els.gateMsg.textContent="Glare tinggi. Perbaiki pencahayaan."; return; }
  const devs = els.wbErr.textContent.split(",").map(x=>Math.abs(parseFloat(x)||0));
  if (Math.max(...devs) > wbMax){ els.gateMsg.textContent="WB ΔRGB besar. Kalibrasi putih/grey card."; return; }
  const stab = parseFloat(els.stability.textContent);
  if (isFinite(stab) && stab > stabMax){ els.gateMsg.textContent="Stabilitas pencahayaan kurang. Tunggu stabil."; return; }
  els.gateMsg.textContent = "";

  // average
  let acc={L:0,a:0,b:0,A:0, glare:0, wb:0, score:0}, n=0;
  let sumDev=0;
  const loop = (i)=> new Promise(res=> {
    setTimeout(()=>{
      const r=analyzeOnce();
      if (r){ acc.L+=r.L; acc.a+=r.a; acc.b+=r.b; acc.A+=r.A; acc.glare+=r.glare; acc.wb+=r.wbDev; acc.score+=r.score; n++; sumDev += Math.abs((state.emaL||r.L)-r.L); }
      res();
    }, delayMs);
  });
  (async ()=> {
    for (let i=0;i<frames;i++) await loop(i);
    if (n>0){
      const L=acc.L/n, a=acc.a/n, b=acc.b/n, A=acc.A/n;
      els.L.textContent=L.toFixed(1);
      els.a.textContent=a.toFixed(1);
      els.b.textContent=b.toFixed(1);
      els.agtron.textContent=A.toFixed(1);
      els.agtronBar.style.width = Math.max(0, Math.min(100, ((A+5)/90)*100)) + "%";
      const cat=categoryFromAgtron(A, els.scheme.value);
      setBadge(cat);
      state.log.push({
        time:new Date().toISOString(),
        L:+L.toFixed(2), a:+a.toFixed(2), b:+b.toFixed(2),
        Agtron:+A.toFixed(2), category:cat.name,
        model:state.model, scale:state.scale, offset:state.offset,
        glare:+(acc.glare/n).toFixed(2), wbDev:+(acc.wb/n).toFixed(2),
        ready:+(acc.score/n).toFixed(0), gate:els.gate.value,
        mode:els.mode.value, device:navigator.userAgent
      });
    }
  })();
}

// Multi-point calibration
function addCalPoint(){
  const A=parseFloat(els.refVal.value);
  if (!isFinite(A)){ alert("Isi angka Agtron referensi."); return; }
  const last=analyzeOnce(); if (!last){ alert("Pastikan kamera aktif & ROI terisi."); return; }
  state.calPoints.push({A, L:last.L, a:last.a, b:last.b});
  els.ptsCount.textContent = state.calPoints.length;
}

function fitModelLinear(){
  if (state.calPoints.length<2){ alert("Butuh ≥2 titik."); return; }
  const X=[], y=[];
  for (const p of state.calPoints){ X.push([1, p.L]); y.push(p.A); }
  const w = fitLeastSquares(X,y, 0.01);
  state.model = {type:'linear', w};
  els.modelInfo.textContent = "Linear (w0 + w1*L)";
  alert(`Model Linear OK.\nw0=${w[0].toFixed(3)}  w1=${w[1].toFixed(4)}`);
  savePrefs();
}

function fitModelPoly(){
  if (state.calPoints.length<3){ alert("Butuh ≥3 titik."); return; }
  const X=[], y=[];
  for (const p of state.calPoints){ X.push([1, p.L, p.a, p.b, p.L*p.L]); y.push(p.A); }
  const w = fitLeastSquares(X,y, 0.1);
  state.model = {type:'poly', w};
  els.modelInfo.textContent = "Polinomial (L,a,b,L²)";
  alert(`Model Polinomial OK.\nw=${w.map(v=>v.toFixed(4)).join(", ")}`);
  savePrefs();
}

function clearPoints(){
  state.calPoints=[];
  els.ptsCount.textContent="0";
  savePrefs();
}

// Export/Import model
function exportModel(){
  const data = {
    version:"2.0",
    gains: state.gains, ccm: state.ccm,
    scale: state.scale, offset: state.offset,
    model: state.model, calPoints: state.calPoints,
    scheme: els.scheme.value, gate: els.gate.value, mode: els.mode.value
  };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = "agtroncam_model.json"; a.click();
  URL.revokeObjectURL(url);
}
function importModelFile(file){
  const reader=new FileReader();
  reader.onload = ()=>{
    try{
      const data=JSON.parse(reader.result);
      if (data.model) state.model=data.model;
      if (data.gains) state.gains=data.gains;
      if (data.ccm) state.ccm=data.ccm;
      if (typeof data.scale==="number") state.scale=data.scale;
      if (typeof data.offset==="number") state.offset=data.offset;
      if (Array.isArray(data.calPoints)) state.calPoints=data.calPoints;
      if (data.scheme) els.scheme.value=data.scheme;
      if (data.gate) els.gate.value=data.gate;
      if (data.mode) els.mode.value=data.mode;
      els.scale.value=state.scale; els.offset.value=state.offset;
      els.scaleVal.textContent=state.scale.toFixed(2);
      els.offsetVal.textContent=state.offset.toFixed(1);
      els.ptsCount.textContent=state.calPoints.length;
      els.modelInfo.textContent=state.model?.type||"Linear";
      savePrefs();
      alert("Model terimpor.");
    }catch(e){ alert("Gagal import: "+e); }
  };
  reader.readAsText(file);
}

// CSV & Snapshot
function exportCSV(){
  if (state.log.length===0){ alert("Belum ada hasil."); return; }
  const head = ["time","L","a","b","Agtron","category","model","scale","offset","glare","wbDev","ready","gate","mode","device"];
  const lines=[head.join(",")];
  for (const r of state.log){
    const row = head.map(k=> JSON.stringify(r[k] ?? ""));
    lines.push(row.join(","));
  }
  const blob=new Blob([lines.join("\n")], {type:"text/csv"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download="agtroncam_ultra_export.csv"; a.click();
  URL.revokeObjectURL(url);
}

function snapshotROI(){
  const {videoWidth:vw, videoHeight:vh} = els.video;
  if (!vw||!vh) return;
  state.ctx.drawImage(els.video,0,0,vw,vh);
  const img=getImageDataFromElem(els.roiCircle);
  const t=document.createElement('canvas'); t.width=img.width; t.height=img.height;
  const tctx=t.getContext('2d'); const put=new ImageData(img.data, img.width, img.height);
  tctx.putImageData(put,0,0);
  t.toBlob(blob=>{
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download="agtron_roi_ultra.png"; a.click();
  }, 'image/png');
}

// Start/Stop
async function startCamera(){
  if (state.running) return;
  if (location.protocol!=='https:' && location.hostname!=='localhost'){
    alert("Kamera butuh HTTPS. Deploy di Vercel atau gunakan localhost.");
    return;
  }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:{ideal:"environment"}, width:{ideal:1920}, height:{ideal:1080}, frameRate:{ideal:30} },
      audio:false
    });
    state.stream=stream;
    els.video.srcObject=stream;
    state.running=true; state.paused=false;
    els.btnPause.textContent="Jeda";
    requestAnimationFrame(loop);
    setTimeout(layoutROIs, 400);
    window.addEventListener('resize', layoutROIs);
  }catch(err){ alert("Gagal akses kamera.\n"+err); }
}
function pauseResume(){
  if (!state.running) return;
  state.paused=!state.paused;
  els.btnPause.textContent = state.paused? "Lanjut":"Jeda";
}
function loop(){
  if (!state.running) return;
  if (!state.paused) analyzeOnce();
  requestAnimationFrame(loop);
}
function stopCamera(){
  if (state.stream){ for (const tr of state.stream.getTracks()) tr.stop(); }
  state.stream=null; state.running=false;
}

// Save/Reset
function savePrefs(){
  localStorage.setItem('agtroncam_ultra', JSON.stringify({
    gains: state.gains, ccm: state.ccm,
    scale: state.scale, offset: state.offset,
    scheme: els.scheme.value, gate: els.gate.value, mode: els.mode.value,
    model: state.model, calPoints: state.calPoints
  }));
}
function resetAll(){
  stopCamera();
  state.gains={r:1,g:1,b:1};
  state.ccm=[[1,0,0],[0,1,0],[0,0,1]];
  state.scale=1.20; state.offset=10.0;
  state.scheme='gourmet'; state.gate='normal'; state.mode='ground';
  state.model={type:'linear', w:[0,1]}; state.calPoints=[];
  els.scale.value=state.scale; els.offset.value=state.offset;
  els.scheme.value=state.scheme; els.gate.value=state.gate; els.mode.value=state.mode;
  els.scaleVal.textContent=state.scale.toFixed(2); els.offsetVal.textContent=state.offset.toFixed(1);
  els.modelInfo.textContent='Linear';
  els.ptsCount.textContent='0';
  state.log=[];
  localStorage.removeItem('agtroncam_ultra');
  els.agtron.textContent='--'; els.L.textContent='--'; els.a.textContent='--'; els.b.textContent='--';
  els.agtronBar.style.width='0%'; els.badge.textContent='—'; els.desc.textContent=''; els.readyBar.style.width='0%';
}

// Events
els.btnStart.addEventListener('click', startCamera);
els.btnPause.addEventListener('click', pauseResume);
els.btnCalib.addEventListener('click', ()=>{
  const r=calibrateWhite();
  alert(`Kalibrasi putih OK.\nROI putih (RGB mean): ${r.r.toFixed(1)}, ${r.g.toFixed(1)}, ${r.b.toFixed(1)}`);
  savePrefs();
});
els.btnGrayCard.addEventListener('click', ()=>{
  const r=optimizeGray();
  alert(`Optimasi gray-card OK.\nROI netral → gains disesuaikan.`);
  savePrefs();
});
els.btnMeasure.addEventListener('click', ()=> measureAveraged(28,18));
els.btnSave.addEventListener('click', savePrefs);
els.btnReset.addEventListener('click', resetAll);
els.btnSnap.addEventListener('click', snapshotROI);
els.scheme.addEventListener('change', savePrefs);
els.gate.addEventListener('change', savePrefs);
els.mode.addEventListener('change', savePrefs);
els.scale.addEventListener('input', (e)=>{ state.scale=parseFloat(e.target.value); els.scaleVal.textContent=state.scale.toFixed(2); savePrefs(); });
els.offset.addEventListener('input', (e)=>{ state.offset=parseFloat(e.target.value); els.offsetVal.textContent=state.offset.toFixed(1); savePrefs(); });

els.capPoint.addEventListener('click', addCalPoint);
els.fitLinear.addEventListener('click', fitModelLinear);
els.fitPoly.addEventListener('click', fitModelPoly);
els.clearPts.addEventListener('click', clearPoints);

els.btnExportCSV.addEventListener('click', exportCSV);
els.btnExportModel.addEventListener('click', exportModel);
els.importModel.addEventListener('change', (e)=>{
  const f=e.target.files?.[0]; if (f) importModelFile(f);
});

// PWA install
let deferredPrompt=null;
window.addEventListener('beforeinstallprompt', (e)=>{ e.preventDefault(); deferredPrompt=e; });
els.btnInstall.addEventListener('click', async ()=>{
  if (deferredPrompt){ deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; }
  else alert("Jika tidak muncul, app sudah terpasang atau tidak memenuhi kriteria.");
});

els.video.addEventListener('loadedmetadata', layoutROIs);
