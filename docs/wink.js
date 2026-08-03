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
const effectLabelEl = document.getElementById('effectLabel');

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

const COLOR_EFFECTS = [
  { name: 'Normal', filter: 'none' },
  { name: 'Invert', filter: 'invert(1)' },
  { name: 'Neon', filter: 'saturate(3) hue-rotate(90deg) contrast(1.2)' },
  { name: 'Sepia Dream', filter: 'sepia(1) saturate(3) hue-rotate(300deg)' },
  { name: 'Cool Blue', filter: 'hue-rotate(200deg) saturate(1.8)' },
  { name: 'Grayscale Pop', filter: 'grayscale(1) contrast(1.4) brightness(1.1)' },
  { name: 'Solarize', filter: 'invert(1) hue-rotate(180deg) saturate(2)' },
  { name: 'Warm Glow', filter: 'sepia(0.6) saturate(2) hue-rotate(-20deg) brightness(1.1)' },
];

let currentStream = null;
let rafId = null;
let faceLandmarker = null;
let modelReady = false;
let particles = [];
let leftWinking = false;
let rightWinking = false;
let colorEffectIndex = 0;

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
    ctx.filter = 'none'; // always draw particles in their true color, regardless of the active color effect
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

function cycleColorEffect() {
  let next = colorEffectIndex;
  if (COLOR_EFFECTS.length > 1) {
    while (next === colorEffectIndex) {
      next = Math.floor(Math.random() * COLOR_EFFECTS.length);
    }
  }
  colorEffectIndex = next;
  if (effectLabelEl) effectLabelEl.textContent = COLOR_EFFECTS[colorEffectIndex].name;
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
    cycleColorEffect();
    leftWinking = true;
  } else if (leftScore < WINK_OFF) {
    leftWinking = false;
  }

  if (isRightWink && !rightWinking) {
    spawnBurst(eyeR.x, eyeR.y);
    cycleColorEffect();
    rightWinking = true;
  } else if (rightScore < WINK_OFF) {
    rightWinking = false;
  }
}

let lastFrameAt = 0;

function loop(timestamp) {
  if (video.videoWidth && video.videoHeight) {
    // Mirror the camera for a natural "look in a mirror" feel. The color effect
    // is applied only to this draw call so particles drawn afterward (words/emoji)
    // always render in their true, unfiltered color.
    ctx.save();
    ctx.filter = COLOR_EFFECTS[colorEffectIndex].filter;
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();

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
    colorEffectIndex = 0;
    if (effectLabelEl) effectLabelEl.textContent = COLOR_EFFECTS[0].name;
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
