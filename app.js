'use strict';

/**
 * AgtronCam — Estimator level roasting kopi berbasis kamera.
 * Pipeline ringkas:
 * 1) Stream kamera → canvas
 * 2) ROI: lingkaran (sampel kopi), kotak kecil (white card)
 * 3) Kalibrasi white balance dari ROI putih → gain RGB
 * 4) Hitung CIELAB (L*, a*, b*) sample (dengan sampling grid)
 * 5) Mapping ke estimasi Agtron: A = scale * L* + offset (tunable)
 * 6) Kualitas: glare %, WB delta, EMA stabilitas
 * 7) Simpan kalibrasi ke localStorage (per device/browser)
 */

const els = {
  video: document.getElementById('video'),
  canvas: document.getElementById('canvas'),
  btnStart: document.getElementById('btnStart'),
  btnPause: document.getElementById('btnPause'),
  btnCalib: document.getElementById('btnCalib'),
  btnMeasure: document.getElementById('btnMeasure'),
  btnSave: document.getElementById('btnSave'),
  btnReset: document.getElementById('btnReset'),
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
  qualityMsg: document.getElementById('qualityMsg'),
  scale: document.getElementById('scale'),
  offset: document.getElementById('offset'),
  scaleVal: document.getElementById('scaleVal'),
  offsetVal: document.getElementById('offsetVal')
};

// Defaults (bisa di-tweak dari UI)
let state = {
  running: false,
  paused: false,
  stream: null,
  ctx: null,
  width: 1280,
  height: 720,
  gains: { r: 1, g: 1, b: 1 }, // WB gains
  scale: 1.20,
  offset: 10.0,
  emaL: null, // exponential moving average untuk stabilitas
  emaAlpha: 0.2
};

// Restore kalibrasi jika ada
(function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem('agtroncam_calib') || '{}');
    if (saved.scale) state.scale = saved.scale;
    if (saved.offset) state.offset = saved.offset;
    if (saved.gains) state.gains = saved.gains;
  } catch {}
  els.scale.value = state.scale;
  els.offset.value = state.offset;
  els.scaleVal.textContent = state.scale.toFixed(2);
  els.offsetVal.textContent = state.offset.toFixed(1);
})();

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function sRGB_to_linear(x){
  // x: 0..1
  return (x <= 0.04045) ? (x / 12.92) : Math.pow((x + 0.055) / 1.055, 2.4);
}
function linear_to_sRGB(x){
  return (x <= 0.0031308) ? (12.92 * x) : (1.055 * Math.pow(x, 1/2.4) - 0.055);
}

// sRGB D65 -> XYZ (normalized 0..1)
function rgb_to_xyz(r, g, b){
  const R = sRGB_to_linear(r);
  const G = sRGB_to_linear(g);
  const B = sRGB_to_linear(b);
  const X = R*0.4124564 + G*0.3575761 + B*0.1804375;
  const Y = R*0.2126729 + G*0.7151522 + B*0.0721750;
  const Z = R*0.0193339 + G*0.1191920 + B*0.9503041;
  return {X, Y, Z};
}

function xyz_to_lab(X, Y, Z){
  // Reference white D65
  const Xn = 0.95047, Yn = 1.00000, Zn = 1.08883;
  let x = X / Xn, y = Y / Yn, z = Z / Zn;
  const eps = 216/24389; // 0.008856
  const kap = 24389/27;  // 903.3
  function f(t){ return (t > eps) ? Math.cbrt(t) : ( (kap * t + 16) / 116 ); }
  const fx = f(x), fy = f(y), fz = f(z);
  const L = 116*fy - 16;
  const a = 500*(fx - fy);
  const b = 200*(fy - fz);
  return {L, a, b};
}

function categoryFromAgtron(A){
  // Buckets approx. (Gourmet-like). Adjust freely if Anda punya standar lain.
  // Very Light (>=75), Light (65-74), Medium-Light (55-64),
  // Medium (45-54), Medium-Dark (35-44), Dark (25-34), Very Dark (<25)
  const c = [
    {name: "Very Light", min: 75, color: "#f59e0b", desc: "Cerah, sangat asam, origin sangat menonjol"},
    {name: "Light", min: 65, color: "#fb923c", desc: "Asam segar, sweetness tinggi"},
    {name: "Medium-Light", min: 55, color: "#f97316", desc: "Seimbang ke arah terang"},
    {name: "Medium", min: 45, color: "#ea580c", desc: "Seimbang; body & sweetness stabil"},
    {name: "Medium-Dark", min: 35, color: "#b45309", desc: "Body meningkat, rasa panggang mulai muncul"},
    {name: "Dark", min: 25, color: "#92400e", desc: "Pahit/roasty dominan, body tinggi"},
    {name: "Very Dark", min: -999, color: "#7c2d12", desc: "Sangat gelap, oils tinggi"}
  ];
  for (const k of c) if (A >= k.min) return k;
  return c[c.length-1];
}

function setBadge(cat){
  els.badge.textContent = cat.name;
  els.badge.style.background = cat.color;
  els.badge.style.color = "white";
  els.desc.textContent = cat.desc;
}

// Layout ROI (dipanggil tiap resize/video ready)
function layoutROIs() {
  const vid = els.video;
  const rect = vid.getBoundingClientRect();
  const W = rect.width, H = rect.height;

  // Lingkaran sample: center, radius ~28% sisi terkecil
  const rad = Math.min(W, H) * 0.28;
  const cx = rect.left + W/2;
  const cy = rect.top + H/2;

  Object.assign(els.roiCircle.style, {
    left: (cx - rad) + "px",
    top: (cy - rad) + "px",
    width: (rad*2) + "px",
    height: (rad*2) + "px"
  });

  // Kotak white card: kanan-atas, ~14% lebar
  const ww = Math.min(W, H) * 0.18;
  const wh = ww * 0.7;
  const pad = 10;
  Object.assign(els.roiWhite.style, {
    left: (rect.left + W - ww - pad) + "px",
    top: (rect.top + pad) + "px",
    width: ww + "px",
    height: wh + "px"
  });
}

// Hitung glare% pada sample ROI (pixel sangat terang)
function glarePercent(data){
  let hot = 0, total = data.length / 4;
  for (let i=0;i<data.length;i+=4){
    const mx = Math.max(data[i], data[i+1], data[i+2]);
    if (mx >= 250) hot++;
  }
  return 100 * hot / total;
}

// EMA sederhana untuk L*
function updateEMA(L){
  state.emaL = (state.emaL == null) ? L : (state.emaAlpha * L + (1 - state.emaAlpha)*state.emaL);
  return state.emaL;
}

// helper ambil ImageData dari ROI css element relatif ke video
function getImageDataFromElem(elem){
  const r = elem.getBoundingClientRect();
  const v = els.video.getBoundingClientRect();

  // Map ke koordinat video asli vs canvas
  const scaleX = state.width / v.width;
  const scaleY = state.height / v.height;

  const x = Math.max(0, Math.round((r.left - v.left) * scaleX));
  const y = Math.max(0, Math.round((r.top - v.top) * scaleY));
  const w = Math.max(1, Math.round(r.width * scaleX));
  const h = Math.max(1, Math.round(r.height * scaleY));

  return state.ctx.getImageData(x, y, w, h);
}

// Sampling grid untuk mempercepat (step pixel)
function iterCirclePixels(img, step=3){
  const {width:w, height:h, data} = img;
  const cx = Math.floor(w/2), cy = Math.floor(h/2);
  const r = Math.min(cx, cy);
  const out = [];
  for (let y=0; y<h; y+=step){
    for (let x=0; x<w; x+=step){
      const dx = x - cx, dy = y - cy;
      if (dx*dx + dy*dy <= r*r){
        const i = (y*w + x) * 4;
        out.push([data[i], data[i+1], data[i+2]]);
      }
    }
  }
  return out;
}

function iterRectPixels(img, step=2){
  const {width:w, height:h, data} = img;
  const out = [];
  for (let y=0; y<h; y+=step){
    for (let x=0; x<w; x+=step){
      const i = (y*w + x) * 4;
      out.push([data[i], data[i+1], data[i+2]]);
    }
  }
  return out;
}

// Kalibrasi WB dari ROI putih → gains
function calibrateWhite(){
  const img = getImageDataFromElem(els.roiWhite);
  const pts = iterRectPixels(img, 4);
  let r=0,g=0,b=0;
  for (const p of pts){ r+=p[0]; g+=p[1]; b+=p[2]; }
  const n = pts.length || 1;
  r/=n; g/=n; b/=n;
  const avg = (r+g+b)/3;
  state.gains = {
    r: (avg / (r||1)),
    g: (avg / (g||1)),
    b: (avg / (b||1))
  };
  return {r, g, b, avg};
}

function analyzeOnce(){
  // Draw frame ke canvas
  const {videoWidth:vw, videoHeight:vh} = els.video;
  if (!vw || !vh) return null;
  state.width = vw; state.height = vh;
  els.canvas.width = vw;
  els.canvas.height = vh;
  if (!state.ctx) state.ctx = els.canvas.getContext('2d', { willReadFrequently: true });
  state.ctx.drawImage(els.video, 0, 0, vw, vh);

  // Ambil ROI circle (sample) & rect (white)
  const sampleImg = getImageDataFromElem(els.roiCircle);
  const whiteImg  = getImageDataFromElem(els.roiWhite);

  const glare = glarePercent(sampleImg.data).toFixed(1);
  els.glare.textContent = glare;

  // WB error (R,G,B deviasi dari rata-rata)
  const wpts = iterRectPixels(whiteImg, 6);
  let wr=0,wg=0,wb=0;
  for (const p of wpts){ wr+=p[0]; wg+=p[1]; wb+=p[2]; }
  const wn = wpts.length || 1;
  wr/=wn; wg/=wn; wb/=wn;
  const wavg = (wr+wg+wb)/3;
  const wbErr = [wr, wg, wb].map(v=> (v - wavg)).map(v=>v.toFixed(1)).join(", ");
  els.wbErr.textContent = wbErr;

  // Iter sample circle, apply WB gains, konversi ke Lab & rata-rata
  const pts = iterCirclePixels(sampleImg, 3);
  let sumL=0, suma=0, sumb=0, cnt=0;
  const g = state.gains;
  for (const p of pts){
    // WB apply + normalize
    let R = clamp01((p[0] * g.r) / 255);
    let G = clamp01((p[1] * g.g) / 255);
    let B = clamp01((p[2] * g.b) / 255);
    // XYZ -> Lab
    const {X,Y,Z} = rgb_to_xyz(R,G,B);
    const lab = xyz_to_lab(X,Y,Z);
    sumL += lab.L; suma += lab.a; sumb += lab.b; cnt++;
  }
  if (cnt === 0) return null;
  const L = sumL/cnt, a = suma/cnt, b = sumb/cnt;
  els.L.textContent = L.toFixed(1);
  els.a.textContent = a.toFixed(1);
  els.b.textContent = b.toFixed(1);

  const ema = updateEMA(L);
  els.stability.textContent = ema ? Math.abs(ema - L).toFixed(2) : "--";

  // Mapping ke Agtron (linear, bisa di-tune di UI)
  const A = state.scale * L + state.offset;
  els.agtron.textContent = A.toFixed(1);
  const pct = clamp01((A + 5) / 90) * 100; // progress bar approx
  els.agtronBar.style.width = pct + "%";

  const cat = categoryFromAgtron(A);
  setBadge(cat);

  // Pesan kualitas
  let msg = [];
  if (parseFloat(glare) > 2.0) msg.push("Kurangi glare: gunakan diffuser / sudut kamera sedikit miring.");
  // WB check
  const maxDev = Math.max(Math.abs(wr-wavg), Math.abs(wg-wavg), Math.abs(wb-wavg));
  if (maxDev > 8) msg.push("Kalibrasi putih disarankan: pastikan kertas putih polos dalam kotak.");
  // Stabilitas
  if (state.emaL != null && Math.abs(state.emaL - L) > 0.8) msg.push("Pencahayaan bergerak: tunggu kamera stabil.");

  els.qualityMsg.textContent = msg.join(" ");

  return {L,a,b,A};
}

// Multi-frame averaging saat klik "Ukur"
async function measureAveraged(frames=15, delayMs=30){
  let acc = {L:0,a:0,b:0,A:0}, n=0;
  for (let i=0;i<frames;i++){
    const res = analyzeOnce();
    if (res){ acc.L+=res.L; acc.a+=res.a; acc.b+=res.b; acc.A+=res.A; n++; }
    await new Promise(r=>setTimeout(r, delayMs));
  }
  if (n>0){
    const L = acc.L/n, a = acc.a/n, b = acc.b/n, A = acc.A/n;
    els.L.textContent = L.toFixed(1);
    els.a.textContent = a.toFixed(1);
    els.b.textContent = b.toFixed(1);
    els.agtron.textContent = A.toFixed(1);
    const pct = Math.min(100, Math.max(0, ((A+5)/90)*100));
    els.agtronBar.style.width = pct + "%";
    const cat = categoryFromAgtron(A);
    setBadge(cat);
  }
}

async function startCamera(){
  if (state.running) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    state.stream = stream;
    els.video.srcObject = stream;
    state.running = true;
    state.paused = false;
    els.btnPause.textContent = "Jeda";
    requestAnimationFrame(loop);
    setTimeout(layoutROIs, 400);
    window.addEventListener('resize', layoutROIs);
  } catch (err){
    alert("Gagal mengakses kamera. Buka via HTTPS dan beri izin kamera.\n\n" + err);
  }
}

function pauseResume(){
  if (!state.running) return;
  state.paused = !state.paused;
  els.btnPause.textContent = state.paused ? "Lanjut" : "Jeda";
}

function loop(){
  if (!state.running) return;
  if (!state.paused) analyzeOnce();
  requestAnimationFrame(loop);
}

function stopCamera(){
  if (state.stream){
    for (const tr of state.stream.getTracks()) tr.stop();
  }
  state.stream = null;
  state.running = false;
}

function saveCalib(){
  localStorage.setItem('agtroncam_calib', JSON.stringify({
    gains: state.gains,
    scale: state.scale,
    offset: state.offset
  }));
  alert("Kalibrasi disimpan di perangkat ini.");
}

function resetAll(){
  stopCamera();
  state.gains = { r:1, g:1, b:1 };
  state.scale = 1.20;
  state.offset = 10.0;
  els.scale.value = state.scale;
  els.offset.value = state.offset;
  els.scaleVal.textContent = state.scale.toFixed(2);
  els.offsetVal.textContent = state.offset.toFixed(1);
  localStorage.removeItem('agtroncam_calib');
  els.agtron.textContent = "--";
  els.L.textContent = "--";
  els.a.textContent = "--";
  els.b.textContent = "--";
  els.agtronBar.style.width = "0%";
  els.badge.textContent = "—";
  els.badge.style.background = "#e5e7eb";
  els.badge.style.color = "#111827";
  els.desc.textContent = "";
  els.qualityMsg.textContent = "—";
}

els.btnStart.addEventListener('click', startCamera);
els.btnPause.addEventListener('click', pauseResume);
els.btnCalib.addEventListener('click', ()=>{
  const r = calibrateWhite();
  alert(`Kalibrasi putih OK.\nRata-rata ROI putih (RGB): ${r.r.toFixed(1)}, ${r.g.toFixed(1)}, ${r.b.toFixed(1)}`);
});
els.btnMeasure.addEventListener('click', ()=> measureAveraged(18, 25));
els.btnSave.addEventListener('click', saveCalib);
els.btnReset.addEventListener('click', resetAll);

els.scale.addEventListener('input', (e)=>{
  state.scale = parseFloat(e.target.value);
  els.scaleVal.textContent = state.scale.toFixed(2);
});
els.offset.addEventListener('input', (e)=>{
  state.offset = parseFloat(e.target.value);
  els.offsetVal.textContent = state.offset.toFixed(1);
});

// Relayout once video metadata available
els.video.addEventListener('loadedmetadata', layoutROIs);
