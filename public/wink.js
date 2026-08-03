import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';

const video = document.getElementById('video');
const canvas = document.getElementById('winkCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const cameraSelect = document.getElementById('cameraSelect');
const showLandmarksCheckbox = document.getElementById('showLandmarks');
const wordListInput = document.getElementById('wordListInput');
const countSlider = document.getElementById('countSlider');
const sizeSlider = document.getElementById('sizeSlider');
const countLabel = document.getElementById('countLabel');
const sizeLabel = document.getElementById('sizeLabel');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const messageEl = document.getElementById('message');

const MAX_DIMENSION = 480;
const WINK_ON = 0.5; // eye counts as "closed" above this blendshape score
const WINK_OFF = 0.28; // eye counts as "open" below this (hysteresis gap avoids re-triggering on noise)
const PARTICLE_LIFETIME_MS = 1600;
const DEFAULT_WORDS = ['😉', '✨', '🎉', '💥', '🌈', '🔥', '🤩', '💫', '🌟', '😜'];
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';

// Standard MediaPipe FaceMesh index groups for each eye, averaged for a stable center point.
const RIGHT_EYE_IDX = [33, 133, 159, 145, 153, 144, 163, 7];
const LEFT_EYE_IDX = [362, 263, 386, 374, 380, 373, 390, 249];

// Color effects are applied via direct pixel manipulation rather than the
// canvas 2D context's `filter` property, since that property has unreliable
// or missing support in some browsers (notably Safari). Each function mutates
// an RGBA pixel in place (data/idx point at the R channel of that pixel).
function pixelNormal() {}

function pixelInvert(data, idx) {
  data[idx] = 255 - data[idx];
  data[idx + 1] = 255 - data[idx + 1];
  data[idx + 2] = 255 - data[idx + 2];
}

function pixelSepia(data, idx) {
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  data[idx] = 0.393 * r + 0.769 * g + 0.189 * b;
  data[idx + 1] = 0.349 * r + 0.686 * g + 0.168 * b;
  data[idx + 2] = 0.272 * r + 0.534 * g + 0.131 * b;
}

// Precomputed saturate(3) + hue-rotate(90deg) color matrix (standard CSS Filter
// Effects formulas), applied per-pixel, followed by a contrast(1.2) boost.
function saturateMatrix(s) {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
}
function hueRotateMatrix(deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
}
function multiplyMatrices3x3(a, b) {
  const out = new Array(9).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[row * 3 + k] * b[k * 3 + col];
      out[row * 3 + col] = sum;
    }
  }
  return out;
}
const NEON_MATRIX = multiplyMatrices3x3(hueRotateMatrix(90), saturateMatrix(3));

function pixelNeon(data, idx) {
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  const nr = NEON_MATRIX[0] * r + NEON_MATRIX[1] * g + NEON_MATRIX[2] * b;
  const ng = NEON_MATRIX[3] * r + NEON_MATRIX[4] * g + NEON_MATRIX[5] * b;
  const nb = NEON_MATRIX[6] * r + NEON_MATRIX[7] * g + NEON_MATRIX[8] * b;
  data[idx] = (nr - 128) * 1.2 + 128;
  data[idx + 1] = (ng - 128) * 1.2 + 128;
  data[idx + 2] = (nb - 128) * 1.2 + 128;
}

// The view is split into a 2x2 grid; each quadrant always renders with its own
// distinct color effect (fixed order: top-left, top-right, bottom-left, bottom-right).
const GRID_EFFECTS = [
  { name: 'Normal', apply: pixelNormal },
  { name: 'Invert', apply: pixelInvert },
  { name: 'Sepia', apply: pixelSepia },
  { name: 'Neon', apply: pixelNeon },
];

let currentStream = null;
let rafId = null;
let faceLandmarker = null;
let modelReady = false;
let particles = [];
let leftWinking = false;
let rightWinking = false;

function setStatus(live) {
  statusEl.textContent = live ? 'Live' : 'Offline';
  statusEl.classList.toggle('live', live);
  statusEl.classList.toggle('offline', !live);
}

function setMessage(text) {
  messageEl.textContent = text || '';
}

function getWordList() {
  const words = wordListInput.value
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  return words.length ? words : DEFAULT_WORDS;
}

async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === 'videoinput');
  cameraSelect.innerHTML = '';
  cameras.forEach((cam, i) => {
    const option = document.createElement('option');
    option.value = cam.deviceId;
    option.textContent = cam.label || `Camera ${i + 1}`;
    cameraSelect.appendChild(option);
  });
  return cameras;
}

async function loadModel() {
  if (modelReady) return;
  setMessage('Loading face-tracking model…');
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

function setupCanvas() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, MAX_DIMENSION / Math.max(vw, vh));
  canvas.width = Math.max(1, Math.round(vw * scale));
  canvas.height = Math.max(1, Math.round(vh * scale));
}

function eyeCenter(landmarks, indices) {
  let sx = 0;
  let sy = 0;
  indices.forEach((i) => {
    sx += landmarks[i].x;
    sy += landmarks[i].y;
  });
  // Raw (unmirrored) position, then flipped to match the mirrored display.
  const rawX = (sx / indices.length) * canvas.width;
  const rawY = (sy / indices.length) * canvas.height;
  return { x: canvas.width - rawX, y: rawY };
}

function spawnBurst(cx, cy) {
  const words = getWordList();
  const count = Number(countSlider.value);
  const now = performance.now();
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * (Math.PI * 0.7); // mostly upward, some spread
    const speed = 40 + Math.random() * 50; // px/sec
    particles.push({
      text: words[Math.floor(Math.random() * words.length)],
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      bornAt: now,
    });
  }
}

function updateAndDrawParticles(now, dtSec) {
  const fontSize = Number(sizeSlider.value);
  particles = particles.filter((p) => now - p.bornAt < PARTICLE_LIFETIME_MS);
  particles.forEach((p) => {
    p.x += p.vx * dtSec;
    p.y += p.vy * dtSec;
    p.vy -= 20 * dtSec; // gentle upward drift, like the words are floating away

    const progress = (now - p.bornAt) / PARTICLE_LIFETIME_MS;
    const alpha = 1 - progress;
    const scale = 1 + progress * 0.6;

    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.translate(p.x, p.y);
    ctx.scale(scale, scale);
    ctx.font = `bold ${fontSize}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff'; // only matters for plain-text particles; emoji glyphs render in native color regardless
    ctx.fillText(p.text, 0, 0);
    ctx.restore();
  });
}

function checkWinks(blendshapes, eyeL, eyeR) {
  if (!blendshapes) return;
  const categories = blendshapes.categories;
  const leftScore = categories.find((c) => c.categoryName === 'eyeBlinkLeft')?.score ?? 0;
  const rightScore = categories.find((c) => c.categoryName === 'eyeBlinkRight')?.score ?? 0;

  const isLeftWink = leftScore > WINK_ON && rightScore < WINK_OFF;
  const isRightWink = rightScore > WINK_ON && leftScore < WINK_OFF;

  if (isLeftWink && !leftWinking) {
    spawnBurst(eyeL.x, eyeL.y);
    leftWinking = true;
  } else if (leftScore < WINK_OFF) {
    leftWinking = false;
  }

  if (isRightWink && !rightWinking) {
    spawnBurst(eyeR.x, eyeR.y);
    rightWinking = true;
  } else if (rightScore < WINK_OFF) {
    rightWinking = false;
  }
}

let lastFrameAt = 0;

function drawGridVideo() {
  const halfW = Math.round(canvas.width / 2);
  const halfH = Math.round(canvas.height / 2);

  // Mirror the camera for a natural "look in a mirror" feel, drawn once as a
  // plain frame. The per-quadrant color effects are then applied directly to
  // the pixel data (not via the canvas `filter` property, which has unreliable
  // support in some browsers), so particles drawn afterward (emoji) are
  // unaffected since they're drawn fresh on top, not part of this pixel pass.
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = frame.data;
  for (let y = 0; y < canvas.height; y++) {
    const effectRow = y < halfH ? 0 : 1;
    for (let x = 0; x < canvas.width; x++) {
      const effectCol = x < halfW ? 0 : 1;
      const idx = (y * canvas.width + x) * 4;
      GRID_EFFECTS[effectRow * 2 + effectCol].apply(data, idx);
    }
  }
  ctx.putImageData(frame, 0, 0);

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(halfW, 0);
  ctx.lineTo(halfW, canvas.height);
  ctx.moveTo(0, halfH);
  ctx.lineTo(canvas.width, halfH);
  ctx.stroke();
  ctx.restore();
}

function loop(timestamp) {
  if (video.videoWidth && video.videoHeight) {
    drawGridVideo();

    if (faceLandmarker) {
      const result = faceLandmarker.detectForVideo(video, timestamp);
      const landmarks = result.faceLandmarks?.[0];
      const blendshapes = result.faceBlendshapes?.[0];

      if (landmarks) {
        const eyeL = eyeCenter(landmarks, LEFT_EYE_IDX);
        const eyeR = eyeCenter(landmarks, RIGHT_EYE_IDX);
        checkWinks(blendshapes, eyeL, eyeR);

        if (showLandmarksCheckbox.checked) {
          ctx.fillStyle = '#4f8cff';
          [eyeL, eyeR].forEach((p) => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            ctx.fill();
          });
        }
        setMessage('');
      } else {
        setMessage('Show your face to the camera…');
      }
    }

    const now = timestamp;
    const dtSec = lastFrameAt ? Math.min(0.1, (now - lastFrameAt) / 1000) : 0.016;
    lastFrameAt = now;
    updateAndDrawParticles(now, dtSec);
  }
  rafId = requestAnimationFrame(loop);
}

async function start() {
  setMessage('');
  startBtn.disabled = true;
  try {
    await loadModel();
    const constraints = {
      video: cameraSelect.value
        ? { deviceId: { exact: cameraSelect.value } }
        : { facingMode: { ideal: 'user' } },
      audio: false,
    };
    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = currentStream;
    await video.play();
    setupCanvas();
    setStatus(true);
    stopBtn.disabled = false;
    saveBtn.disabled = false;
    particles = [];
    leftWinking = false;
    rightWinking = false;
    lastFrameAt = 0;
    rafId = requestAnimationFrame(loop);
    await listCameras();
  } catch (err) {
    setStatus(false);
    setMessage(`Could not start: ${err.message}`);
    startBtn.disabled = false;
  }
}

function stop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
    currentStream = null;
  }
  video.srcObject = null;
  setStatus(false);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setMessage('Stopped.');
}

function saveImage() {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wink-emojis-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

countSlider.addEventListener('input', () => {
  countLabel.textContent = countSlider.value;
});
sizeSlider.addEventListener('input', () => {
  sizeLabel.textContent = `${sizeSlider.value}px`;
});

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
saveBtn.addEventListener('click', saveImage);

(async function init() {
  countLabel.textContent = countSlider.value;
  sizeLabel.textContent = `${sizeSlider.value}px`;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setMessage('This browser does not support camera access.');
    startBtn.disabled = true;
    return;
  }
  setMessage('Click "Start" to load the face-tracking model and begin.');
  await listCameras();
})();
