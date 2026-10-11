const db = require('./db');

// Valores por defecto. Todo se puede cambiar desde Configuración.
const DEFAULTS = {
  business_name: 'Estética',
  business_phone: '',
  business_address: '',
  timezone: 'America/Argentina/Buenos_Aires',
  public_url: '', // URL pública (https) donde está publicado el sistema, necesaria para webhooks
  currency: 'ARS',

  // Agenda
  slot_interval_min: '30',
  capacity: '1', // cantidad de clientes que se pueden atender al mismo tiempo (camas / cabinas)
  booking_window_days: '30',
  min_advance_min: '60',
  booking_hold_min: '15', // minutos que se reserva el turno mientras se espera el pago de la seña
  booking_terms: 'La seña confirma el turno y se descuenta del total. Cancelaciones con al menos 24 hs de anticipación.',

  // Mercado Pago
  mp_access_token: '',
  mp_public_key: '',
  mp_webhook_secret: '',

  // Tienda Nube
  tn_client_id: '',
  tn_client_secret: '',
  tn_store_id: '',
  tn_access_token: '',
  tn_user_agent: '',
  tn_auto_sync: '1',
  tn_sync_price: '1',
};

// Claves que nunca se devuelven completas al frontend.
const SECRET_KEYS = ['mp_access_token', 'mp_webhook_secret', 'tn_client_secret', 'tn_access_token'];

function getAll() {
  const rows = db.all('SELECT key, value FROM settings');
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function get(key) {
  const row = db.one('SELECT value FROM settings WHERE key = ?', key);
  if (row && row.value !== null) return row.value;
  return DEFAULTS[key] ?? '';
}

function getInt(key) {
  const n = parseInt(get(key), 10);
  return Number.isFinite(n) ? n : parseInt(DEFAULTS[key] || '0', 10);
}

function set(values) {
  const stmt = db.get().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  db.tx(() => {
    for (const [key, value] of Object.entries(values)) {
      if (!(key in DEFAULTS)) continue;
      stmt.run(key, value === null || value === undefined ? '' : String(value));
    }
  });
}

function mask(value) {
  if (!value) return '';
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function publicView() {
  const all = getAll();
  for (const key of SECRET_KEYS) {
    all[`${key}_set`] = Boolean(all[key]);
    all[key] = mask(all[key]);
  }
  return all;
}

function publicUrl() {
  return (get('public_url') || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
}

module.exports = { DEFAULTS, SECRET_KEYS, getAll, get, getInt, set, publicView, publicUrl };
