const video = document.getElementById('video');
const phoneFeed = document.getElementById('phoneFeed');
const cameraSelect = document.getElementById('cameraSelect');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const snapshotBtn = document.getElementById('snapshotBtn');
const canvas = document.getElementById('canvas');
const downloadLink = document.getElementById('downloadLink');
const statusEl = document.getElementById('status');
const messageEl = document.getElementById('message');
const laptopControls = document.getElementById('laptopControls');
const phoneControls = document.getElementById('phoneControls');
const phoneUrlsEl = document.getElementById('phoneUrls');
const sourceRadios = document.querySelectorAll('input[name="source"]');

const PHONE_POLL_MS = 150;

let currentStream = null;
let phonePollTimer = null;
let currentSource = 'laptop';

function setStatus(live) {
  statusEl.textContent = live ? 'Live' : 'Offline';
  statusEl.classList.toggle('live', live);
  statusEl.classList.toggle('offline', !live);
}

function setMessage(text) {
  messageEl.textContent = text || '';
}

// --- Laptop camera (local getUserMedia) --------------------------------

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

async function startLaptopFeed() {
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

function stopLaptopFeed() {
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
  const source = currentSource === 'phone' ? phoneFeed : video;
  const width = currentSource === 'phone' ? source.naturalWidth : source.videoWidth;
  const height = currentSource === 'phone' ? source.naturalHeight : source.videoHeight;
  if (!width || !height) return;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, width, height);
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    downloadLink.href = url;
    downloadLink.download = `snapshot-${Date.now()}.png`;
    downloadLink.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

startBtn.addEventListener('click', startLaptopFeed);
stopBtn.addEventListener('click', stopLaptopFeed);
snapshotBtn.addEventListener('click', takeSnapshot);

// --- Phone camera (polled frame relay) ----------------------------------

async function loadPhoneUrls() {
  try {
    const res = await fetch('/api/server-info');
    const info = await res.json();
    phoneUrlsEl.innerHTML = '';
    if (!info.ips.length) {
      phoneUrlsEl.innerHTML = '<li>Could not detect a LAN IP. Make sure this laptop is connected to WiFi.</li>';
      return;
    }
    info.ips.forEach((ip) => {
      const li = document.createElement('li');
      li.textContent = `https://${ip}:${info.port}/phone`;
      phoneUrlsEl.appendChild(li);
    });
  } catch (err) {
    phoneUrlsEl.innerHTML = '<li>Could not load server info.</li>';
  }
}

async function pollPhoneStatus() {
  try {
    const res = await fetch('/api/status');
    const status = await res.json();
    if (status.hasFrame && status.ageMs < 3000) {
      phoneFeed.src = `/api/frame.jpg?t=${Date.now()}`;
      setStatus(true);
      setMessage('');
      snapshotBtn.disabled = false;
    } else if (status.hasFrame) {
      setStatus(false);
      setMessage('Phone feed stalled — check the phone is still open and connected.');
      snapshotBtn.disabled = true;
    } else {
      setStatus(false);
      setMessage('Waiting for phone to connect…');
      snapshotBtn.disabled = true;
    }
  } catch (err) {
    setStatus(false);
    setMessage('Could not reach server.');
  }
}

function startPhoneMode() {
  loadPhoneUrls();
  pollPhoneStatus();
  phonePollTimer = setInterval(pollPhoneStatus, PHONE_POLL_MS);
}

function stopPhoneMode() {
  if (phonePollTimer) {
    clearInterval(phonePollTimer);
    phonePollTimer = null;
  }
}

// --- Source switching ----------------------------------------------------

function switchSource(source) {
  currentSource = source;
  if (source === 'laptop') {
    stopPhoneMode();
    phoneFeed.classList.add('hidden');
    video.classList.remove('hidden');
    laptopControls.classList.remove('hidden');
    phoneControls.classList.add('hidden');
    snapshotBtn.disabled = !currentStream;
    setStatus(!!currentStream);
    setMessage(currentStream ? '' : 'Click "Start" to begin the live feed.');
  } else {
    stopLaptopFeed();
    video.classList.add('hidden');
    phoneFeed.classList.remove('hidden');
    laptopControls.classList.add('hidden');
    phoneControls.classList.remove('hidden');
    startPhoneMode();
  }
}

sourceRadios.forEach((radio) => {
  radio.addEventListener('change', (e) => switchSource(e.target.value));
});

(async function init() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setMessage('This browser does not support camera access.');
    startBtn.disabled = true;
  } else {
    setMessage('Click "Start" to begin the live feed.');
    await listCameras();
  }
})();
