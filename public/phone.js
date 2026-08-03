const video = document.getElementById('video');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const switchCameraBtn = document.getElementById('switchCameraBtn');
const statusEl = document.getElementById('status');
const messageEl = document.getElementById('message');
const statsEl = document.getElementById('stats');
const canvas = document.getElementById('canvas');

const FRAME_INTERVAL_MS = 150; // ~6-7 fps
const MAX_WIDTH = 640;
const JPEG_QUALITY = 0.6;

let currentStream = null;
let captureTimer = null;
let facingMode = 'environment';
let sentCount = 0;
let failCount = 0;

function setStatus(live) {
  statusEl.textContent = live ? 'Streaming' : 'Offline';
  statusEl.classList.toggle('live', live);
  statusEl.classList.toggle('offline', !live);
}

function setMessage(text) {
  messageEl.textContent = text || '';
}

async function startCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
  }
  currentStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facingMode } },
    audio: false,
  });
  video.srcObject = currentStream;
}

function captureAndSendFrame() {
  if (!video.videoWidth || !video.videoHeight) return;

  const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, width, height);

  canvas.toBlob(
    async (blob) => {
      if (!blob) return;
      try {
        const res = await fetch('/api/frame', {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg' },
          body: blob,
        });
        if (res.ok) {
          sentCount += 1;
        } else {
          failCount += 1;
        }
      } catch (err) {
        failCount += 1;
      }
      statsEl.textContent = `Sent ${sentCount} frames (${failCount} failed)`;
    },
    'image/jpeg',
    JPEG_QUALITY
  );
}

async function startStreaming() {
  setMessage('');
  try {
    await startCamera();
    setStatus(true);
    startBtn.disabled = true;
    stopBtn.disabled = false;
    captureTimer = setInterval(captureAndSendFrame, FRAME_INTERVAL_MS);
  } catch (err) {
    setStatus(false);
    setMessage(`Could not access camera: ${err.message}`);
  }
}

function stopStreaming() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
    currentStream = null;
  }
  video.srcObject = null;
  setStatus(false);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setMessage('Streaming stopped.');
}

async function switchCamera() {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  if (currentStream) {
    await startCamera();
  }
}

startBtn.addEventListener('click', startStreaming);
stopBtn.addEventListener('click', stopStreaming);
switchCameraBtn.addEventListener('click', switchCamera);

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  setMessage('This browser does not support camera access.');
  startBtn.disabled = true;
} else {
  setMessage('Tap "Start streaming" to send this camera to the laptop.');
}
