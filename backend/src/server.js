require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');
const routes = require('./routes');
const realtime = require('./realtime');
const { requireAuth } = require('./auth');
const devices = require('./devices');
const voice = require('./voice');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined,
});

app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || 1 : false);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com/gsi/style'],
        frameSrc: ['https://accounts.google.com/gsi/'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'https://accounts.google.com/gsi/', ...voice.cspOrigins()],
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // the Google sign-in popup
  })
);
// Allow the mic and camera only for this origin (live rooms); no geolocation.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=()');
  next();
});
app.use(express.json({ limit: '100kb' }));

app.set('io', io);
app.set('presence', realtime.attach(io));

// ICE servers for WebRTC. Public STUN works on most networks; set TURN_* for strict NATs/corporate Wi-Fi.
app.get('/api/rtc-config', requireAuth, (req, res) => {
  const iceServers = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',') }];
  if (process.env.TURN_URL)
    iceServers.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  res.json({ iceServers });
});

// Device-key API for the browser extension and desktop tracker (separate auth, CORS-enabled).
app.use('/api/device', devices.router);
app.use('/api/device', (err, req, res, next) => {
  if (err.expose && err.status) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});
// Privacy policy and terms, with the operator's details from OPERATOR_NAME / OPERATOR_EMAIL.
const legal = (file) => (req, res) => {
  const fill = (v, d) => String(v || d).replace(/[<>&"]/g, '');
  const html = require('fs').readFileSync(path.join(__dirname, '..', 'legal', file), 'utf8')
    .replaceAll('{{OPERATOR}}', fill(process.env.OPERATOR_NAME, 'the operator of this Synapse server'))
    .replaceAll('{{CONTACT}}', process.env.OPERATOR_EMAIL ? `<a href="mailto:${fill(process.env.OPERATOR_EMAIL)}">${fill(process.env.OPERATOR_EMAIL)}</a>` : 'via the site admin')
    .replaceAll('{{UPDATED}}', '15 October 2026');
  res.type('html').send(html);
};
app.get('/privacy.html', legal('privacy.html'));
app.get('/terms.html', legal('terms.html'));

app.use('/api', routes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
// LiveKit browser SDK, served from node_modules so it stays same-origin and pinned to package-lock.
app.get('/vendor/livekit-client.umd.js', (req, res) =>
  res.sendFile(path.join(path.dirname(require.resolve('livekit-client')), 'livekit-client.umd.js'), { maxAge: '7d' }));
// QR code generator for "scan to connect" on the phone (MIT, served from node_modules).
app.get('/vendor/qrcode.js', (req, res) =>
  res.sendFile(path.join(path.dirname(require.resolve('qrcode-generator')), 'qrcode.js'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const db = require('./db');
const PORT = Number(process.env.PORT) || 3000;
const ready = db.init();

if (require.main === module) {
  ready
    .then(() => server.listen(PORT, () => console.log(`Synapse AI running at http://localhost:${PORT} (database: ${db.describe()})`)))
    .catch((e) => {
      console.error(`FATAL: could not open the database (${db.describe()}): ${e.message}`);
      if (db.dialect === 'postgres') console.error('Check DATABASE_URL. Hosted databases often need ?sslmode=require at the end of the URL.');
      process.exit(1);
    });
  const shutdown = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { app, server, io, ready, db };
