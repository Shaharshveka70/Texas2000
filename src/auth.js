const crypto = require('node:crypto');
const { newToken } = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'sid';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(req, value, maxAgeSeconds) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (req.secure) parts.push('Secure');
  return parts.join('; ');
}

function createSession(db, req, res, restaurantId) {
  const token = newToken(24);
  const expires = Date.now() + SESSION_DAYS * 86400e3;
  db.prepare('DELETE FROM staff_sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO staff_sessions (token, restaurant_id, expires_at) VALUES (?, ?, ?)').run(token, restaurantId, expires);
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_DAYS * 86400));
}

function destroySession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM staff_sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
}

function currentRestaurant(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  return db.prepare(`
    SELECT r.id, r.name, r.username, r.ordering_enabled
    FROM staff_sessions s JOIN restaurants r ON r.id = s.restaurant_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, Date.now()) || null;
}

function requireStaff(db) {
  return (req, res, next) => {
    // Cookie auth + JSON-only writes: a cross-site form cannot send application/json without a CORS preflight.
    if (req.method !== 'GET' && !req.is('application/json')) {
      return res.status(415).json({ error: 'json_required' });
    }
    const restaurant = currentRestaurant(db, req);
    if (!restaurant) return res.status(401).json({ error: 'unauthorized' });
    req.restaurant = restaurant;
    next();
  };
}

// In-memory brute-force guard for login attempts.
function loginLimiter({ max = 10, windowMs = 15 * 60e3 } = {}) {
  const hits = new Map();
  const live = (key) => {
    const h = hits.get(key);
    if (h && h.until < Date.now()) { hits.delete(key); return null; }
    return h;
  };
  return {
    blocked: (key) => (live(key)?.count || 0) >= max,
    fail(key) {
      const h = live(key);
      if (h) h.count++;
      else hits.set(key, { count: 1, until: Date.now() + windowMs });
    },
    reset: (key) => hits.delete(key),
  };
}

module.exports = { hashPassword, verifyPassword, createSession, destroySession, currentRestaurant, requireStaff, loginLimiter };
