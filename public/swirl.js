import { HandLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';

const video = document.getElementById('video');
const canvas = document.getElementById('swirlCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const cameraSelect = document.getElementById('cameraSelect');
const showLandmarksCheckbox = document.getElementById('showLandmarks');
const strengthSlider = document.getElementById('strengthSlider');
const radiusSlider = document.getElementById('radiusSlider');
const strengthLabel = document.getElementById('strengthLabel');
const radiusLabel = document.getElementById('radiusLabel');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const messageEl = document.getElementById('message');
const videoWrap = document.getElementById('videoWrap');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const exitFullscreenBtn = document.getElementById('exitFullscreenBtn');

const MAX_DIMENSION = 400;
const HAND_HOLD_MS = 500; // keep swirling at the last known spot briefly after the hand drops out
const PALM_LANDMARKS = [0, 5, 9, 13, 17]; // wrist + finger MCPs, averaged for a stable palm center
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';

let currentStream = null;
let rafId = null;
let handLandmarker = null;
let modelReady = false;
let lastHandPos = null;
let lastHandAt = 0;

function setStatus(live) {
  statusEl.textContent = live ? 'Live' : 'Offline';
  statusEl.classList.toggle('live', live);
  statusEl.classList.toggle('offline', !live);
}

function setMessage(text) {
  messageEl.textContent = text || '';
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
  setMessage('Loading hand-tracking model…');
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  try {
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 1,
    });
  } catch (err) {
    // Some browsers (notably older Safari/iOS) don't support the GPU delegate.
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 1,
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

function detectHandCenter(timestampMs) {
  if (!handLandmarker || !video.videoWidth) return null;
  const result = handLandmarker.detectForVideo(video, timestampMs);
  if (!result.landmarks || !result.landmarks.length) return null;
  const landmarks = result.landmarks[0];
  let sx = 0;
  let sy = 0;
  PALM_LANDMARKS.forEach((i) => {
    sx += landmarks[i].x;
    sy += landmarks[i].y;
  });
  return {
    x: (sx / PALM_LANDMARKS.length) * canvas.width,
    y: (sy / PALM_LANDMARKS.length) * canvas.height,
  };
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

function loop(timestamp) {
  if (video.videoWidth && video.videoHeight) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const hand = detectHandCenter(timestamp);
    if (hand) {
      lastHandPos = hand;
      lastHandAt = timestamp;
    }

    const usingHand = lastHandPos && timestamp - lastHandAt < HAND_HOLD_MS;
    if (usingHand) {
      const radius = Number(radiusSlider.value);
      const strength = Number(strengthSlider.value);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const warped = applySwirl(
        frame,
        canvas.width,
        canvas.height,
        lastHandPos.x,
        lastHandPos.y,
        radius,
        strength
      );
      ctx.putImageData(warped, 0, 0);

      if (showLandmarksCheckbox.checked) {
        ctx.beginPath();
        ctx.arc(lastHandPos.x, lastHandPos.y, 6, 0, Math.PI * 2);
        ctx.strokeStyle = '#4f8cff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(lastHandPos.x, lastHandPos.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(79, 140, 255, 0.4)';
        ctx.stroke();
      }
      setMessage('');
    } else {
      setMessage('Show your hand to the camera…');
    }
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
        : { facingMode: { ideal: 'environment' } },
      audio: false,
    };
    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = currentStream;
    await video.play();
    setupCanvas();
    setStatus(true);
    stopBtn.disabled = false;
    saveBtn.disabled = false;
    lastHandPos = null;
    lastHandAt = 0;
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
    a.download = `swirl-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen() {
  if (!isFullscreen()) {
    (videoWrap.requestFullscreen || videoWrap.webkitRequestFullscreen)?.call(videoWrap);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  }
}

function onFullscreenChange() {
  const fs = isFullscreen();
  exitFullscreenBtn.classList.toggle('hidden', !fs);
  fullscreenBtn.textContent = fs ? 'Exit Fullscreen' : 'Fullscreen';
}

strengthSlider.addEventListener('input', () => {
  strengthLabel.textContent = strengthSlider.value;
});
radiusSlider.addEventListener('input', () => {
  radiusLabel.textContent = `${radiusSlider.value}px`;
});

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
saveBtn.addEventListener('click', saveImage);
fullscreenBtn.addEventListener('click', toggleFullscreen);
exitFullscreenBtn.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

(async function init() {
  strengthLabel.textContent = strengthSlider.value;
  radiusLabel.textContent = `${radiusSlider.value}px`;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setMessage('This browser does not support camera access.');
    startBtn.disabled = true;
    return;
  }
  setMessage('Click "Start" to load the hand-tracking model and begin.');
  await listCameras();
})();
