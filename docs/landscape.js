import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';

const video = document.getElementById('video');
const canvas = document.getElementById('landscapeCanvas');
const ctx = canvas.getContext('2d');
const showCameraCheckbox = document.getElementById('showCamera');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const messageEl = document.getElementById('message');

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';

const DUST_COUNT = 26;
const CREATURE_COUNT = 10;

// --- Palettes -------------------------------------------------------------
// Five named "weather states" blended continuously by trait weight, never
// shown as text — only ever expressed as color, light, fog, and motion.
const PALETTES = {
  dormant: { top: '#2a2f45', bottom: '#3d4568', sun: '#c8cfe0', fog: '#c8d2e6', ground: '#232a40' },
  calm: { top: '#7ec8e3', bottom: '#dff1f8', sun: '#fff6d8', fog: '#ffffff', ground: '#3f6b4f' },
  playful: { top: '#ff9d6c', bottom: '#ffe08a', sun: '#fff2b0', fog: '#ffe6c2', ground: '#4a7a4f' },
  curious: { top: '#5ad1c7', bottom: '#bdf3e6', sun: '#eafff8', fog: '#dcfff5', ground: '#2f6a5e' },
  tired: { top: '#241b3a', bottom: '#4a3866', sun: '#c9b6ea', fog: '#9678b4', ground: '#241b30' },
};

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const PALETTE_RGB = {};
for (const key in PALETTES) {
  PALETTE_RGB[key] = {};
  for (const part in PALETTES[key]) {
    PALETTE_RGB[key][part] = hexToRgb(PALETTES[key][part]);
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function blendRgb(colorsWithWeights) {
  let r = 0;
  let g = 0;
  let b = 0;
  let wsum = 0;
  colorsWithWeights.forEach(([rgb, w]) => {
    r += rgb[0] * w;
    g += rgb[1] * w;
    b += rgb[2] * w;
    wsum += w;
  });
  if (wsum <= 0) return [0, 0, 0];
  return [r / wsum, g / wsum, b / wsum];
}

function rgbCss([r, g, b], a = 1) {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}

// --- Smoothed traits -------------------------------------------------------
// Continuous, internal-only signals derived from face blendshapes. Never
// displayed as labels, numbers, or scores — they only ever drive the scene.
const traits = {
  presence: 0,
  openness: 0.75,
  tiredness: 0,
  playful: 0,
  curious: 0,
};

function approach(current, target, dt, tau) {
  const alpha = 1 - Math.exp(-dt / Math.max(0.001, tau));
  return current + (target - current) * alpha;
}

function getScore(categories, name) {
  return categories.find((c) => c.categoryName === name)?.score ?? 0;
}

function computeRawSignals(blendshapes) {
  const categories = blendshapes.categories;
  const blinkL = getScore(categories, 'eyeBlinkLeft');
  const blinkR = getScore(categories, 'eyeBlinkRight');
  const wideL = getScore(categories, 'eyeWideLeft');
  const wideR = getScore(categories, 'eyeWideRight');
  const smileL = getScore(categories, 'mouthSmileLeft');
  const smileR = getScore(categories, 'mouthSmileRight');
  const jawOpen = getScore(categories, 'jawOpen');
  const browInnerUp = getScore(categories, 'browInnerUp');
  const browOuterUpL = getScore(categories, 'browOuterUpLeft');
  const browOuterUpR = getScore(categories, 'browOuterUpRight');

  return {
    openness: 1 - (blinkL + blinkR) / 2,
    wideness: (wideL + wideR) / 2,
    smile: (smileL + smileR) / 2,
    jawOpen,
    browRaise: (browInnerUp + browOuterUpL + browOuterUpR) / 3,
  };
}

function updateTraits(raw, dt, faceDetected) {
  const targetPresence = faceDetected ? 1 : 0;
  traits.presence = approach(traits.presence, targetPresence, dt, faceDetected ? 0.5 : 1.8);

  if (faceDetected) {
    traits.openness = approach(traits.openness, raw.openness, dt, 0.25);

    const drowsySignal = clamp01(1 - raw.openness - 0.15);
    traits.tiredness = approach(traits.tiredness, drowsySignal, dt, drowsySignal > traits.tiredness ? 3.5 : 2);

    const playSignal = clamp01(raw.smile * 0.65 + raw.jawOpen * 0.45);
    traits.playful = approach(traits.playful, playSignal, dt, playSignal > traits.playful ? 0.35 : 1.2);

    const curiousSignal = clamp01(raw.browRaise * 1.3 + raw.wideness * 0.3);
    traits.curious = approach(traits.curious, curiousSignal, dt, curiousSignal > traits.curious ? 0.4 : 1.4);
  } else {
    traits.openness = approach(traits.openness, 0.75, dt, 2);
    traits.tiredness = approach(traits.tiredness, 0, dt, 3);
    traits.playful = approach(traits.playful, 0, dt, 2);
    traits.curious = approach(traits.curious, 0, dt, 2);
  }
}

function energyLevel() {
  return clamp01(traits.playful * 0.5 + traits.curious * 0.3 + traits.openness * 0.2) * traits.presence;
}

function paletteWeights() {
  const p = traits.presence;
  const rest = 1 - p;
  const active = traits.playful + traits.curious + traits.tiredness;
  const calmW = Math.max(0, 1 - Math.min(1, active));
  const norm = calmW + active || 1;
  return {
    dormant: rest,
    calm: p * (calmW / norm),
    playful: p * (traits.playful / norm),
    curious: p * (traits.curious / norm),
    tired: p * (traits.tiredness / norm),
  };
}

function currentPalette() {
  const w = paletteWeights();
  const parts = ['top', 'bottom', 'sun', 'fog', 'ground'];
  const out = {};
  parts.forEach((part) => {
    out[part] = blendRgb(Object.keys(w).map((key) => [PALETTE_RGB[key][part], w[key]]));
  });
  return out;
}

// --- Scene state ------------------------------------------------------------
let cssWidth = 800;
let cssHeight = 450;
let dustMotes = [];
let creatures = [];

function initDust() {
  dustMotes = Array.from({ length: DUST_COUNT }, () => ({
    x: Math.random() * cssWidth,
    y: Math.random() * cssHeight * 0.85,
    r: 1 + Math.random() * 2,
    phase: Math.random() * Math.PI * 2,
    speed: 0.3 + Math.random() * 0.6,
  }));
}

function initCreatures() {
  creatures = Array.from({ length: CREATURE_COUNT }, () => ({
    baseX: cssWidth * (0.12 + 0.76 * Math.random()),
    baseY: cssHeight * (0.55 + 0.3 * Math.random()),
    phase: Math.random() * Math.PI * 2,
    speed: 0.5 + Math.random() * 0.6,
    hue: 38 + Math.random() * 30,
  }));
}

function setupCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cssWidth = Math.max(1, rect.width);
  cssHeight = Math.max(1, rect.height);
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  initDust();
  initCreatures();
}

function drawFogBands(t, palette, energy) {
  const bands = [
    { yFrac: 0.55, amp: 14, freq: 0.02, speed: 0.4, baseAlpha: 0.1 },
    { yFrac: 0.68, amp: 20, freq: 0.015, speed: 0.25, baseAlpha: 0.14 },
    { yFrac: 0.8, amp: 10, freq: 0.025, speed: 0.55, baseAlpha: 0.09 },
  ];
  const fogAmount = 0.35 + 0.9 * traits.tiredness;
  bands.forEach((band) => {
    const yBase = cssHeight * band.yFrac;
    const speedMul = 0.3 + energy * 1.4;
    const offset = t * band.speed * speedMul * 30;
    ctx.beginPath();
    ctx.moveTo(0, cssHeight);
    for (let x = 0; x <= cssWidth; x += 8) {
      const y = yBase + Math.sin((x + offset) * band.freq) * band.amp;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(cssWidth, cssHeight);
    ctx.closePath();
    ctx.fillStyle = rgbCss(palette.fog, Math.min(0.85, band.baseAlpha * fogAmount * 3));
    ctx.fill();
  });
}

function drawGround(t, palette, energy) {
  const groundY = cssHeight * 0.86;
  const windAmp = 4 + energy * 10;
  const windSpeed = 0.6 + energy * 1.5;
  ctx.beginPath();
  ctx.moveTo(0, cssHeight);
  for (let x = 0; x <= cssWidth; x += 10) {
    const y =
      groundY +
      Math.sin(x * 0.04 + t * windSpeed) * windAmp * 0.3 +
      Math.sin(x * 0.011 - t * windSpeed * 0.6) * windAmp * 0.6;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(cssWidth, cssHeight);
  ctx.closePath();
  ctx.fillStyle = rgbCss(palette.ground);
  ctx.fill();
}

function updateAndDrawDust(dt, energy) {
  const activeCount = Math.round(DUST_COUNT * (0.35 + energy * 0.65));
  const speedMul = 0.4 + energy * 1.6;
  dustMotes.forEach((m, i) => {
    if (i >= activeCount) return;
    m.phase += dt * m.speed * speedMul;
    m.y -= dt * (8 + energy * 18);
    m.x += Math.sin(m.phase) * 0.4;
    if (m.y < -10) {
      m.y = cssHeight + 10;
      m.x = Math.random() * cssWidth;
    }
    const alpha = 0.25 + 0.25 * Math.sin(m.phase * 0.7 + i);
    ctx.beginPath();
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.max(0.05, Math.min(0.6, alpha))})`;
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fill();
  });
}

function updateAndDrawCreatures(t, energy) {
  const activeCount = Math.round(
    CREATURE_COUNT * clamp01(0.15 + traits.playful * 0.7 + traits.curious * 0.6) * traits.presence
  );
  const approachAmount = traits.curious;
  creatures.forEach((c, i) => {
    if (i >= activeCount) return;
    const bob = Math.sin(t * c.speed * (1 + energy) + c.phase);
    const sway = Math.cos(t * c.speed * 0.7 + c.phase);
    const targetX = lerp(c.baseX, cssWidth * 0.5, approachAmount * 0.4);
    const targetY = lerp(c.baseY, cssHeight * 0.5, approachAmount * 0.4);
    const x = targetX + sway * 18 * (1 + energy);
    const y = targetY + bob * 14 * (1 + energy);
    const glowPulse = 0.5 + 0.5 * Math.sin(t * (2 + traits.playful * 3) + c.phase);
    const r = 2.2 + traits.playful * 2.5 + glowPulse * 1.2;
    const alpha = 0.5 + 0.4 * glowPulse;

    const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
    grad.addColorStop(0, `hsla(${c.hue}, 90%, 70%, ${alpha})`);
    grad.addColorStop(1, `hsla(${c.hue}, 90%, 70%, 0)`);
    ctx.beginPath();
    ctx.fillStyle = grad;
    ctx.arc(x, y, r * 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.fillStyle = `hsla(${c.hue}, 95%, 85%, ${Math.min(1, alpha + 0.3)})`;
    ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawLandscape(t) {
  const palette = currentPalette();
  const energy = energyLevel();
  const breathe = 0.5 + 0.5 * Math.sin(t * 0.15);

  const grad = ctx.createLinearGradient(0, 0, 0, cssHeight);
  grad.addColorStop(0, rgbCss(palette.top));
  grad.addColorStop(1, rgbCss(palette.bottom));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const sunX = cssWidth * 0.5 + Math.sin(t * 0.05) * cssWidth * 0.32;
  const sunY = cssHeight * 0.28 + Math.sin(t * 0.08) * cssHeight * 0.05;
  const sunBaseR = Math.min(cssWidth, cssHeight) * (0.05 + 0.03 * traits.openness + 0.02 * energy);
  const glowStrength = (0.5 + 0.5 * traits.openness) * (0.7 + 0.3 * breathe);
  for (let i = 3; i >= 0; i--) {
    const r = sunBaseR * (1 + i * 0.9);
    const alpha = (0.28 / (i + 1)) * glowStrength;
    ctx.beginPath();
    ctx.fillStyle = rgbCss(palette.sun, alpha);
    ctx.arc(sunX, sunY, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.fillStyle = rgbCss(palette.sun, 0.9);
  ctx.arc(sunX, sunY, sunBaseR, 0, Math.PI * 2);
  ctx.fill();

  drawFogBands(t, palette, energy);
  drawGround(t, palette, energy);
}

// --- Camera + model lifecycle ----------------------------------------------
let currentStream = null;
let faceLandmarker = null;
let modelReady = false;
let cameraActive = false;
let rafId = null;
let lastTimestamp = 0;

function setStatus(live) {
  statusEl.textContent = live ? 'Live' : 'Offline';
  statusEl.classList.toggle('live', live);
  statusEl.classList.toggle('offline', !live);
}

function setMessage(text) {
  messageEl.textContent = text || '';
}

async function loadModel() {
  if (modelReady) return;
  setMessage('Waking the landscape…');
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  };
  try {
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, options);
  } catch (err) {
    // Some browsers (notably older Safari/iOS) don't support the GPU delegate.
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'CPU' },
    });
  }
  modelReady = true;
}

async function start() {
  setMessage('Waking the landscape…');
  startBtn.disabled = true;
  try {
    await loadModel();
    currentStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'user' } },
      audio: false,
    });
    video.srcObject = currentStream;
    await video.play();
    cameraActive = true;
    setStatus(true);
    stopBtn.disabled = false;
    saveBtn.disabled = false;
    setMessage('');
  } catch (err) {
    setMessage(`Could not start: ${err.message}`);
    startBtn.disabled = false;
  }
}

function stop() {
  cameraActive = false;
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
    currentStream = null;
  }
  video.srcObject = null;
  setStatus(false);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setMessage('Paused. The landscape rests.');
}

function saveImage() {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `landscape-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

function renderLoop(timestamp) {
  const dt = lastTimestamp ? Math.min(0.1, (timestamp - lastTimestamp) / 1000) : 0.016;
  lastTimestamp = timestamp;

  if (cameraActive && faceLandmarker && video.videoWidth) {
    const result = faceLandmarker.detectForVideo(video, timestamp);
    const landmarks = result.faceLandmarks?.[0];
    const blendshapes = result.faceBlendshapes?.[0];
    const faceDetected = !!(landmarks && blendshapes);
    updateTraits(faceDetected ? computeRawSignals(blendshapes) : null, dt, faceDetected);
  } else {
    updateTraits(null, dt, false);
  }

  drawLandscape(timestamp / 1000);
  rafId = requestAnimationFrame(renderLoop);
}

showCameraCheckbox.addEventListener('change', () => {
  video.classList.toggle('pip-off', !showCameraCheckbox.checked);
});

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
saveBtn.addEventListener('click', saveImage);

window.addEventListener('resize', setupCanvas);

(function init() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setMessage('This browser does not support camera access.');
    startBtn.disabled = true;
  }
  setupCanvas();
  rafId = requestAnimationFrame(renderLoop);
})();
