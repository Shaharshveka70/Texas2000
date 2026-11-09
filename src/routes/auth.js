// Restaurant sign-up / login / logout.
const express = require('express');
const { verifyPassword, createSession, destroySession, currentRestaurant, loginLimiter } = require('../auth');
const { createRestaurant } = require('../seed');

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;

function authRouter({ db }) {
  const r = express.Router();
  const limiter = loginLimiter();

  r.use((req, res, next) => {
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'json_required' });
    next();
  });

  r.post('/signup', (req, res) => {
    const name = String(req.body?.restaurantName || '').trim();
    const username = String(req.body?.username || '').trim();
    const password = req.body?.password;
    const tables = req.body?.tables ?? 20;
    if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'invalid_name' });
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'invalid_username' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'weak_password' });
    if (!Number.isInteger(tables) || tables < 1 || tables > 100) return res.status(400).json({ error: 'invalid_tables' });
    if (db.prepare('SELECT 1 FROM restaurants WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'username_taken' });
    }
    const id = createRestaurant(db, { name, username, password, tables });
    createSession(db, req, res, id);
    res.status(201).json({ ok: true });
  });

  r.post('/login', (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const key = `${username.toLowerCase()}|${req.ip}`;
    if (limiter.blocked(key)) return res.status(429).json({ error: 'too_many_attempts' });
    const row = db.prepare('SELECT id, password_hash FROM restaurants WHERE username = ?').get(username);
    if (!row || !verifyPassword(password, row.password_hash)) {
      limiter.fail(key);
      return res.status(401).json({ error: 'bad_credentials' });
    }
    limiter.reset(key);
    createSession(db, req, res, row.id);
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => {
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    const restaurant = currentRestaurant(db, req);
    if (!restaurant) return res.status(401).json({ error: 'unauthorized' });
    res.json({ name: restaurant.name, username: restaurant.username });
  });

  return r;
}

module.exports = { authRouter };
