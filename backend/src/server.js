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
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:', ...voice.cspOrigins()],
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
      },
    },
  })
);
// Allow the mic only for this origin; no camera/geolocation needed.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
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
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});
app.use('/api', routes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
// LiveKit browser SDK, served from node_modules so it stays same-origin and pinned to package-lock.
app.get('/vendor/livekit-client.umd.js', (req, res) =>
  res.sendFile(path.join(path.dirname(require.resolve('livekit-client')), 'livekit-client.umd.js'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  server.listen(PORT, () => console.log(`Synapse AI running at http://localhost:${PORT}`));
}

module.exports = { app, server, io };
