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

const SEPIA_FILTER = 'sepia(1) saturate(3) hue-rotate(300deg)';

// How much the face has to move (in canvas px/sec) before the swirl kicks in, and
// how that speed maps to swirl strength. Speed is smoothed so the swirl flows with
// the motion instead of flickering on/off frame-to-frame.
const FACE_DISTORT_SENSITIVITY = 0.09;
const FACE_DISTORT_MAX_STRENGTH = 14;
const FACE_DISTORT_MIN_STRENGTH = 0.15;
const FACE_DISTORT_SMOOTHING = 0.75; // higher = more trailing/fluid, lower = snappier
const FACE_DISTORT_RADIUS_MULTIPLIER = 2.2; // relative to eye distance, so it scales with face size
const FACE_DISTORT_RADIUS_MIN = 50;
const FACE_DISTORT_RADIUS_MAX = 260;
const NOSE_TIP_IDX = 1;

let currentStream = null;
let rafId = null;
let faceLandmarker = null;
let modelReady = false;
let particles = [];
let leftWinking = false;
let rightWinking = false;
let prevFaceCenter = null;
let prevFaceAt = 0;
let smoothedSpeed = 0;

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

function applySwirl(imageData, width, height, cx, cy, radius, angle) {
  const src = imageData.data;
  const out = new Uint8ClampedArray(src);
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(width - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(height - 1, Math.ceil(cy + radius));
  const radius2 = radius * radius;

  for (let y = minY; y <= maxY; y++) {
    const dy0 = y - cy;
    for (let x = minX; x <= maxX; x++) {
      const dx0 = x - cx;
      const d2 = dx0 * dx0 + dy0 * dy0;
      if (d2 > radius2) continue;
      const d = Math.sqrt(d2);
      const percent = (radius - d) / radius;
      const theta = percent * percent * angle;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const srcX = Math.round(cx + dx0 * cosT - dy0 * sinT);
      const srcY = Math.round(cy + dx0 * sinT + dy0 * cosT);
      if (srcX < 0 || srcX >= width || srcY < 0 || srcY >= height) continue;
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = (y * width + x) * 4;
      out[dstIdx] = src[srcIdx];
      out[dstIdx + 1] = src[srcIdx + 1];
      out[dstIdx + 2] = src[srcIdx + 2];
      out[dstIdx + 3] = src[srcIdx + 3];
    }
  }
  return new ImageData(out, width, height);
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
    ctx.filter = 'none'; // always draw particles in their true color, regardless of the sepia effect
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

function applyFaceMotionDistortion(landmarks, eyeL, eyeR, timestamp) {
  const faceCenter = eyeCenter(landmarks, [NOSE_TIP_IDX]);

  if (prevFaceCenter) {
    const dtSec = (timestamp - prevFaceAt) / 1000;
    if (dtSec > 0) {
      const dx = faceCenter.x - prevFaceCenter.x;
      const dy = faceCenter.y - prevFaceCenter.y;
      const rawSpeed = Math.hypot(dx, dy) / dtSec; // canvas px/sec
      smoothedSpeed = smoothedSpeed * FACE_DISTORT_SMOOTHING + rawSpeed * (1 - FACE_DISTORT_SMOOTHING);
      const strength = Math.min(FACE_DISTORT_MAX_STRENGTH, smoothedSpeed * FACE_DISTORT_SENSITIVITY);

      if (strength > FACE_DISTORT_MIN_STRENGTH) {
        const eyeDist = Math.hypot(eyeR.x - eyeL.x, eyeR.y - eyeL.y);
        const radius = Math.min(
          FACE_DISTORT_RADIUS_MAX,
          Math.max(FACE_DISTORT_RADIUS_MIN, eyeDist * FACE_DISTORT_RADIUS_MULTIPLIER)
        );
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const warped = applySwirl(frame, canvas.width, canvas.height, faceCenter.x, faceCenter.y, radius, strength);
        ctx.putImageData(warped, 0, 0);
      }
    }
  }
  prevFaceCenter = faceCenter;
  prevFaceAt = timestamp;
}

function loop(timestamp) {
  if (video.videoWidth && video.videoHeight) {
    // Mirror the camera for a natural "look in a mirror" feel. The sepia effect
    // is applied only to this draw call so particles drawn afterward (emoji)
    // always render in their true, unfiltered color.
    ctx.save();
    ctx.filter = SEPIA_FILTER;
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
        applyFaceMotionDistortion(landmarks, eyeL, eyeR, timestamp);

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
        prevFaceCenter = null;
        smoothedSpeed = 0;
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
    prevFaceCenter = null;
    prevFaceAt = 0;
    smoothedSpeed = 0;
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
