// Voice rooms. With LIVEKIT_* set, audio runs through a LiveKit media server (SFU), which scales to
// large rooms and works on more networks. Without it, the dashboard falls back to peer-to-peer WebRTC
// (realtime.js), which is fine for about 6 people.
const { AccessToken, TrackSource } = require('livekit-server-sdk');

const URL_ = process.env.LIVEKIT_URL;
const KEY = process.env.LIVEKIT_API_KEY;
const SECRET = process.env.LIVEKIT_API_SECRET;
const enabled = !!(URL_ && KEY && SECRET);

if ((URL_ || KEY || SECRET) && !enabled) console.warn('[voice] LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must all be set. Using peer-to-peer voice.');

async function tokenFor(user, roomId) {
  const at = new AccessToken(KEY, SECRET, {
    identity: `user-${user.id}`,
    name: user.name,
    ttl: '2h',
    metadata: JSON.stringify({ userId: user.id }),
  });
  at.addGrant({
    room: `synapse-${roomId}`,
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishData: false,
    canPublishSources: [TrackSource.MICROPHONE], // voice only: no camera or screen share
  });
  return at.toJwt();
}

// Origins the browser must be allowed to reach (for the Content-Security-Policy).
function cspOrigins() {
  if (!enabled) return [];
  try {
    const u = new URL(URL_);
    const host = u.host;
    return [`wss://${host}`, `https://${host}`, `ws://${host}`, `http://${host}`].filter((o) =>
      u.protocol === 'ws:' || u.protocol === 'http:' ? true : o.startsWith('wss') || o.startsWith('https')
    ).concat(host.endsWith('livekit.cloud') ? ['https://*.livekit.cloud', 'wss://*.livekit.cloud'] : []);
  } catch {
    return [];
  }
}

module.exports = { enabled, url: URL_, tokenFor, cspOrigins, MESH_LIMIT: 6 };
