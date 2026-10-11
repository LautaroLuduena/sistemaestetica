const crypto = require('node:crypto');
const db = require('./db');
const { HttpError, token, sqlNow } = require('./util');

const SESSION_DAYS = 14;
const COOKIE = 'sid';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

function createUser(username, password, name = null) {
  return db.run('INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?)', username, name, hashPassword(password));
}

// Crea el usuario administrador inicial si no existe ninguno.
function ensureAdmin() {
  const { n } = db.one('SELECT COUNT(*) AS n FROM users');
  if (n > 0) return null;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || token(9);
  createUser(username, password, 'Administrador');
  return { username, password, generated: !process.env.ADMIN_PASSWORD };
}

function login(username, password) {
  const user = db.one('SELECT * FROM users WHERE username = ?', String(username || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    throw new HttpError(401, 'Usuario o contraseña incorrectos');
  }
  const sid = token(32);
  db.run('DELETE FROM sessions WHERE expires_at < ?', sqlNow());
  db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', sid, user.id, sqlNow(SESSION_DAYS * 86400e3));
  return { sid, user: { id: user.id, username: user.username, name: user.name } };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionUser(req) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (!sid) return null;
  return db.one(
    `SELECT u.id, u.username, u.name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
    sid,
    sqlNow()
  );
}

function setSessionCookie(req, res, sid) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(COOKIE, sid, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: SESSION_DAYS * 86400e3,
    path: '/',
  });
}

function logout(req, res) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (sid) db.run('DELETE FROM sessions WHERE token = ?', sid);
  res.clearCookie(COOKIE, { path: '/' });
}

function requireAuth(req, res, next) {
  const user = sessionUser(req);
  if (!user) return next(new HttpError(401, 'Sesión expirada, volvé a ingresar'));
  req.user = user;
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createUser,
  ensureAdmin,
  login,
  logout,
  sessionUser,
  setSessionCookie,
  requireAuth,
};
