const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const notFound = (msg = 'No encontrado') => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function money(value, field = 'importe') {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`El ${field} no es válido`);
  return round2(n);
}

function int(value, field = 'cantidad') {
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`La ${field} debe ser un número entero`);
  return n;
}

function requireText(value, field) {
  const s = String(value ?? '').trim();
  if (!s) throw badRequest(`Falta ${field}`);
  return s;
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fromMinutes = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Fecha y hora "de pared" en la zona horaria del negocio.
function nowInTz(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const weekday = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay();

// Timestamps en UTC con el mismo formato que datetime('now') de SQLite.
const sqlNow = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').slice(0, 19);

const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

module.exports = {
  HttpError,
  badRequest,
  notFound,
  conflict,
  round2,
  money,
  int,
  requireText,
  isDate,
  isTime,
  toMinutes,
  fromMinutes,
  nowInTz,
  addDays,
  weekday,
  sqlNow,
  token,
};
