const os = require('os');
const https = require('https');
const express = require('express');
const path = require('path');
const selfsigned = require('selfsigned');

const PORT = process.env.PORT || 3443;
const HOST = '0.0.0.0';

// Phones require a secure context (HTTPS) to grant camera access to anything
// that isn't "localhost", so we generate a local self-signed certificate
// covering this machine's LAN IPs. Browsers will show a one-time warning
// for it (expected for self-signed certs) that the user clicks through.
function getLocalIPv4s() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const entries of Object.values(ifaces)) {
    for (const iface of entries) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function generateCert(ips) {
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: ips[0] || 'localhost' }], {
    days: 825,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  return { key: pems.private, cert: pems.cert };
}

const localIPs = getLocalIPv4s();
const { key, cert } = generateCert(localIPs);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// --- Phone -> laptop frame relay -------------------------------------
// The phone posts JPEG frames periodically; we keep only the latest one
// in memory and the viewer polls for it. Simple and robust on a LAN,
// at the cost of true real-time smoothness.
let latestFrame = null;
let latestFrameAt = 0;

app.post('/api/frame', express.raw({ type: 'image/jpeg', limit: '5mb' }), (req, res) => {
  if (!req.body || !req.body.length) {
    res.status(400).end();
    return;
  }
  latestFrame = req.body;
  latestFrameAt = Date.now();
  res.status(204).end();
});

app.get('/api/frame.jpg', (req, res) => {
  if (!latestFrame) {
    res.status(404).end();
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'image/jpeg');
  res.send(latestFrame);
});

app.get('/api/status', (req, res) => {
  const ageMs = latestFrame ? Date.now() - latestFrameAt : null;
  res.json({ hasFrame: !!latestFrame, ageMs });
});

app.get('/api/server-info', (req, res) => {
  res.json({ ips: localIPs, port: PORT });
});

const server = https.createServer({ key, cert }, app);

server.listen(PORT, HOST, () => {
  console.log(`Live feed app running:`);
  console.log(`  On this laptop:  https://localhost:${PORT}`);
  localIPs.forEach((ip) => {
    console.log(`  On your phone:   https://${ip}:${PORT}/phone`);
  });
  console.log(`\nBrowsers will warn about the self-signed certificate the first time — click "Advanced" / "Proceed" to continue.`);
});
