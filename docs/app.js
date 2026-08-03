const video = document.getElementById('video');
const cameraSelect = document.getElementById('cameraSelect');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const snapshotBtn = document.getElementById('snapshotBtn');
const canvas = document.getElementById('canvas');
const downloadLink = document.getElementById('downloadLink');
const statusEl = document.getElementById('status');
const messageEl = document.getElementById('message');

let currentStream = null;

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

async function startFeed() {
  setMessage('');
  try {
    const constraints = {
      video: cameraSelect.value
        ? { deviceId: { exact: cameraSelect.value } }
        : true,
      audio: false,
    };
    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = currentStream;
    setStatus(true);
    startBtn.disabled = true;
    stopBtn.disabled = false;
    snapshotBtn.disabled = false;
    await listCameras();
  } catch (err) {
    setStatus(false);
    setMessage(`Could not access camera: ${err.message}`);
  }
}

function stopFeed() {
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
    currentStream = null;
  }
  video.srcObject = null;
  setStatus(false);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  snapshotBtn.disabled = true;
  setMessage('Feed stopped.');
}

function takeSnapshot() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    downloadLink.href = url;
    downloadLink.download = `snapshot-${Date.now()}.png`;
    downloadLink.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

startBtn.addEventListener('click', startFeed);
stopBtn.addEventListener('click', stopFeed);
snapshotBtn.addEventListener('click', takeSnapshot);

(async function init() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setMessage('This browser does not support camera access.');
    startBtn.disabled = true;
    return;
  }
  setMessage('Click "Start" to begin the live feed.');
  await listCameras();
})();
