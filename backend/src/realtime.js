// Socket.IO: room presence, persisted room chat, focus status, and WebRTC signaling (small mesh audio).
const db = require('./db');
const { verify } = require('./auth');

const MAX_AUDIO_PEERS = 6; // mesh audio stays usable up to ~6 people; beyond that use an SFU.
const members = new Map(); // socketId -> { userId, name, roomId, focusing, focusEndsAt, audio, muted }

function roomMembers(roomId) {
  return [...members.entries()]
    .filter(([, m]) => m.roomId === roomId)
    .map(([socketId, m]) => ({ socketId, userId: m.userId, name: m.name, focusing: m.focusing, focusEndsAt: m.focusEndsAt, audio: m.audio, muted: m.muted }));
}

function attach(io) {
  io.use((socket, next) => {
    try {
      socket.user = verify(socket.handshake.auth?.token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  const roomExists = async (id) => !!(await db.get('SELECT 1 AS ok FROM rooms WHERE id = ?', [id]));
  const insertMsg = (roomId, userId, body) => db.insert('INSERT INTO room_messages (room_id, user_id, body) VALUES (?, ?, ?)', [roomId, userId, body]);

  // Simple per-socket flood control for chat.
  const lastMsgs = new Map();
  function allowMessage(id) {
    const now = Date.now();
    const arr = (lastMsgs.get(id) || []).filter((t) => now - t < 10000);
    if (arr.length >= 8) return false;
    arr.push(now);
    lastMsgs.set(id, arr);
    return true;
  }

  const broadcastPresence = (roomId) => roomId && io.to(roomId).emit('room:presence', roomMembers(roomId));

  function leave(socket) {
    const m = members.get(socket.id);
    if (!m || !m.roomId) return;
    const roomId = m.roomId;
    if (m.audio) socket.to(roomId).emit('audio:peer-left', { socketId: socket.id });
    socket.leave(roomId);
    m.roomId = null;
    m.audio = false;
    broadcastPresence(roomId);
    io.emit('rooms:counts');
  }

  io.on('connection', (socket) => {
    members.set(socket.id, { userId: socket.user.id, name: socket.user.name, roomId: null, focusing: false, focusEndsAt: null, audio: false, muted: false });

    socket.on('room:join', async ({ roomId } = {}, ack) => {
      try {
        if (typeof roomId !== 'string' || !(await roomExists(roomId))) return ack?.({ error: 'Room not found.' });
      } catch (e) {
        console.error('[rooms] join failed:', e.message);
        return ack?.({ error: 'Could not join right now. Try again.' });
      }
      const m = members.get(socket.id);
      if (!m) return; // disconnected meanwhile
      leave(socket);
      m.roomId = roomId;
      socket.join(roomId);
      broadcastPresence(roomId);
      io.emit('rooms:counts');
      ack?.({ ok: true, members: roomMembers(roomId) });
    });

    socket.on('room:leave', (_, ack) => {
      leave(socket);
      ack?.({ ok: true });
    });

    socket.on('room:message', async ({ body } = {}, ack) => {
      const m = members.get(socket.id);
      const text = typeof body === 'string' ? body.trim() : '';
      if (!m?.roomId) return ack?.({ error: 'Join a room first.' });
      if (!text || text.length > 500) return ack?.({ error: 'Messages must be 1-500 characters.' });
      if (!allowMessage(socket.id)) return ack?.({ error: 'Slow down a little.' });
      const roomId = m.roomId;
      let id;
      try {
        id = await insertMsg(roomId, m.userId, text);
      } catch (e) {
        console.error('[rooms] message save failed:', e.message);
        return ack?.({ error: 'Message not sent. Try again.' });
      }
      const msg = { id, body: text, author: m.name, userId: m.userId, created_at: new Date().toISOString().replace('T', ' ').slice(0, 19) };
      io.to(roomId).emit('room:message', msg);
      ack?.({ ok: true });
    });

    socket.on('room:status', ({ focusing, focusEndsAt } = {}) => {
      const m = members.get(socket.id);
      if (!m) return;
      m.focusing = !!focusing;
      m.focusEndsAt = focusing && Number.isFinite(focusEndsAt) ? focusEndsAt : null;
      broadcastPresence(m.roomId);
    });

    // --- WebRTC audio (mesh). The newcomer receives the list of existing audio peers and sends offers to each.
    socket.on('audio:join', (_, ack) => {
      const m = members.get(socket.id);
      if (!m?.roomId) return ack?.({ error: 'Join a room first.' });
      const peers = roomMembers(m.roomId).filter((p) => p.audio && p.socketId !== socket.id);
      if (peers.length >= MAX_AUDIO_PEERS) return ack?.({ error: `Audio is limited to ${MAX_AUDIO_PEERS} people per room.` });
      m.audio = true;
      m.muted = false;
      broadcastPresence(m.roomId);
      ack?.({ ok: true, peers: peers.map((p) => ({ socketId: p.socketId, name: p.name })) });
    });

    socket.on('audio:leave', () => {
      const m = members.get(socket.id);
      if (!m?.roomId || !m.audio) return;
      m.audio = false;
      socket.to(m.roomId).emit('audio:peer-left', { socketId: socket.id });
      broadcastPresence(m.roomId);
    });

    // LiveKit mode: media goes through the SFU, so the socket only carries who is on voice for presence.
    socket.on('voice:status', ({ on, muted } = {}) => {
      const m = members.get(socket.id);
      if (!m?.roomId) return;
      m.audio = !!on;
      m.muted = !!on && !!muted;
      broadcastPresence(m.roomId);
    });

    socket.on('audio:mute', ({ muted } = {}) => {
      const m = members.get(socket.id);
      if (!m?.audio) return;
      m.muted = !!muted;
      broadcastPresence(m.roomId);
    });

    // Relay SDP offers/answers and ICE candidates only between audio peers in the same room.
    socket.on('rtc:signal', ({ to, data } = {}) => {
      const me = members.get(socket.id);
      const peer = members.get(to);
      if (!me?.audio || !peer?.audio || me.roomId !== peer.roomId) return;
      if (!data || typeof data !== 'object' || JSON.stringify(data).length > 20000) return;
      io.to(to).emit('rtc:signal', { from: socket.id, name: me.name, data });
    });

    socket.on('disconnect', () => {
      leave(socket);
      members.delete(socket.id);
      lastMsgs.delete(socket.id);
    });
  });

  // Distinct people currently in a room (for the room list).
  return (roomId) => {
    const seen = new Map();
    for (const m of members.values()) if (m.roomId === roomId) seen.set(m.userId, { name: m.name, focusing: m.focusing });
    return [...seen.values()];
  };
}

module.exports = { attach };
