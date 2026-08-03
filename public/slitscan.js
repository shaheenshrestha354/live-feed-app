const video = document.getElementById('video');
const canvas = document.getElementById('scanCanvas');
const ctx = canvas.getContext('2d');
const cameraSelect = document.getElementById('cameraSelect');
const orientationSelect = document.getElementById('orientationSelect');
const widthSlider = document.getElementById('widthSlider');
const speedSlider = document.getElementById('speedSlider');
const widthLabel = document.getElementById('widthLabel');
const speedLabel = document.getElementById('speedLabel');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const messageEl = document.getElementById('message');

const MAX_DIMENSION = 480;

let currentStream = null;
let rafId = null;
let lastCaptureAt = 0;

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

function clearCanvas() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function setupCanvas() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, MAX_DIMENSION / Math.max(vw, vh));
  canvas.width = Math.max(1, Math.round(vw * scale));
  canvas.height = Math.max(1, Math.round(vh * scale));
  clearCanvas();
}

function captureSlice() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  const orientation = orientationSelect.value;
  const thickness = Math.min(Number(widthSlider.value), orientation === 'vertical' ? canvas.width - 1 : canvas.height - 1);
  if (thickness < 1) return;

  if (orientation === 'vertical') {
    ctx.drawImage(
      canvas,
      thickness, 0, canvas.width - thickness, canvas.height,
      0, 0, canvas.width - thickness, canvas.height
    );
    const sx = Math.max(0, Math.round((vw - thickness) / 2));
    ctx.drawImage(
      video,
      sx, 0, thickness, vh,
      canvas.width - thickness, 0, thickness, canvas.height
    );
  } else {
    ctx.drawImage(
      canvas,
      0, thickness, canvas.width, canvas.height - thickness,
      0, 0, canvas.width, canvas.height - thickness
    );
    const sy = Math.max(0, Math.round((vh - thickness) / 2));
    ctx.drawImage(
      video,
      0, sy, vw, thickness,
      0, canvas.height - thickness, canvas.width, thickness
    );
  }
}

function loop(timestamp) {
  const interval = Number(speedSlider.value);
  if (timestamp - lastCaptureAt >= interval) {
    captureSlice();
    lastCaptureAt = timestamp;
  }
  rafId = requestAnimationFrame(loop);
}

async function start() {
  setMessage('');
  try {
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
    startBtn.disabled = true;
    stopBtn.disabled = false;
    resetBtn.disabled = false;
    saveBtn.disabled = false;
    lastCaptureAt = 0;
    rafId = requestAnimationFrame(loop);
    await listCameras();
  } catch (err) {
    setStatus(false);
    setMessage(`Could not access camera: ${err.message}`);
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
    a.download = `slitscan-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

widthSlider.addEventListener('input', () => {
  widthLabel.textContent = `${widthSlider.value}px`;
});
speedSlider.addEventListener('input', () => {
  speedLabel.textContent = `${speedSlider.value}ms`;
});

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
resetBtn.addEventListener('click', clearCanvas);
saveBtn.addEventListener('click', saveImage);

(async function init() {
  widthLabel.textContent = `${widthSlider.value}px`;
  speedLabel.textContent = `${speedSlider.value}ms`;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setMessage('This browser does not support camera access.');
    startBtn.disabled = true;
    return;
  }
  setMessage('Choose a camera and click "Start" to begin scanning.');
  await listCameras();
})();
