const crypto = require('node:crypto');
const http = require('./http');
const settings = require('../settings');
const { HttpError, round2 } = require('../util');

const API = 'https://api.mercadopago.com';

function accessToken() {
  const t = settings.get('mp_access_token') || process.env.MP_ACCESS_TOKEN || '';
  if (!t) throw new HttpError(503, 'Mercado Pago no está configurado (falta el Access Token)');
  return t;
}

const isConfigured = () => Boolean(settings.get('mp_access_token') || process.env.MP_ACCESS_TOKEN);

const call = (path, opts = {}) =>
  http.json(`${API}${path}`, { ...opts, headers: { Authorization: `Bearer ${accessToken()}`, ...(opts.headers || {}) } });

// Mercado Pago espera fechas ISO con offset explícito.
const mpDate = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');

/**
 * Crea una preferencia de Checkout Pro y devuelve { id, init_point }.
 * externalReference identifica qué se está pagando: "appt:<id>" (seña) o "sale:<id>" (venta de caja).
 */
async function createPreference({ title, amount, externalReference, payer = {}, returnPath, expiresInMin, depositMode = false }) {
  const base = settings.publicUrl();
  const isHttps = base.startsWith('https://');
  const body = {
    items: [{ id: externalReference, title, quantity: 1, unit_price: round2(amount), currency_id: settings.get('currency') || 'ARS' }],
    external_reference: externalReference,
    statement_descriptor: (settings.get('business_name') || 'ESTETICA').slice(0, 22),
    metadata: { reference: externalReference },
  };
  const payerData = {};
  if (payer.name) payerData.name = payer.name;
  if (payer.email) payerData.email = payer.email;
  if (payer.phone) payerData.phone = { number: String(payer.phone) };
  if (Object.keys(payerData).length) body.payer = payerData;

  if (base && returnPath) {
    const url = `${base}${returnPath}`;
    body.back_urls = { success: url, pending: url, failure: url };
    // Mercado Pago solo acepta auto_return con URLs públicas https.
    if (isHttps) body.auto_return = 'approved';
  }
  if (isHttps) body.notification_url = `${base}/api/webhooks/mercadopago?source_news=webhooks`;

  if (depositMode) {
    // Para señas: el pago se aprueba o rechaza en el momento (sin pagos en efectivo que se acreditan días después).
    body.binary_mode = true;
    body.payment_methods = { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] };
  }
  if (expiresInMin) {
    body.expires = true;
    body.expiration_date_from = mpDate(Date.now() - 60e3);
    body.expiration_date_to = mpDate(Date.now() + expiresInMin * 60e3);
  }

  const pref = await call('/checkout/preferences', { method: 'POST', body });
  const sandbox = accessToken().startsWith('TEST-');
  return { id: pref.id, init_point: sandbox && pref.sandbox_init_point ? pref.sandbox_init_point : pref.init_point };
}

const getPayment = (paymentId) => call(`/v1/payments/${encodeURIComponent(paymentId)}`);

function refund(paymentId, amount) {
  return call(`/v1/payments/${encodeURIComponent(paymentId)}/refunds`, {
    method: 'POST',
    headers: { 'X-Idempotency-Key': crypto.randomUUID() },
    body: amount ? { amount: round2(amount) } : {},
  });
}

const me = () => call('/users/me');

/**
 * Valida la firma x-signature de las notificaciones (si se configuró la clave secreta del webhook).
 * Formato: "ts=<timestamp>,v1=<hmac>". Manifiesto: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
 */
function verifySignature(headers, dataId) {
  const secret = settings.get('mp_webhook_secret') || process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;
  const signature = String(headers['x-signature'] || '');
  const parts = Object.fromEntries(
    signature.split(',').map((kv) => {
      const [k, ...v] = kv.trim().split('=');
      return [k, v.join('=')];
    })
  );
  if (!parts.ts || !parts.v1) return false;
  let manifest = '';
  if (dataId) manifest += `id:${/^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : dataId};`;
  if (headers['x-request-id']) manifest += `request-id:${headers['x-request-id']};`;
  manifest += `ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, createPreference, getPayment, refund, me, verifySignature };
