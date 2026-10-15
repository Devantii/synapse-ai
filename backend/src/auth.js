const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';
let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  if (IS_PROD) {
    console.error('FATAL: JWT_SECRET must be set when NODE_ENV=production.');
    process.exit(1);
  }
  // Random per-process secret in development: sessions reset when the server restarts.
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] JWT_SECRET not set - using a random development secret (logins reset on restart).');
}

const TOKEN_TTL = process.env.JWT_TTL || '7d';

function sign(user) {
  return jwt.sign({ sub: user.id, name: user.display_name }, SECRET, { expiresIn: TOKEN_TTL });
}

function verify(token) {
  const p = jwt.verify(token, SECRET);
  return { id: p.sub, name: p.name };
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in required.' });
  try {
    req.user = verify(token);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

module.exports = { sign, verify, requireAuth };
