const db = require('../db');
const http = require('./http');
const settings = require('../settings');
const agenda = require('./agenda');
const { log } = require('./log');
const { HttpError, round2 } = require('../util');

const GRAPH = 'https://graph.facebook.com/v21.0';

const isConfigured = () => Boolean(settings.get('wa_token') && settings.get('wa_phone_number_id') && settings.get('wa_template_name'));
const isEnabled = () => settings.get('wa_enabled') === '1' && isConfigured();

/**
 * Normaliza un teléfono argentino al formato que usa WhatsApp: 549 + característica + número.
 * Acepta "11 2345-6789", "011 15 2345-6789", "+54 9 11 2345 6789", etc.
 */
function toWhatsAppNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  d = d.replace(/^00/, '');
  if (d.startsWith('54')) d = d.slice(2);
  d = d.replace(/^0/, '');
  if (d.startsWith('9') && d.length === 11) return `54${d}`;
  // Quita el "15" de celulares escritos a la antigua: característica (2 a 4 dígitos) + 15 + número.
  if (d.length === 12) {
    for (const areaLen of [2, 3, 4]) {
      if (d.slice(areaLen, areaLen + 2) === '15') {
        d = d.slice(0, areaLen) + d.slice(areaLen + 2);
        break;
      }
    }
  }
  if (d.length === 10) return `549${d}`;
  return null;
}

// Una sola línea: WhatsApp no acepta saltos de línea dentro de las variables de una plantilla.
const oneLine = (s) => String(s ?? '').replace(/\s*\n+\s*/g, ' · ').replace(/\s{2,}/g, ' ').trim() || '-';

function fmtDate(iso) {
  const s = new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const fmtMoney = (n) => `$${round2(n).toLocaleString('es-AR')}`;

// Valores disponibles para las variables de la plantilla.
function fieldsFor(appt) {
  return {
    nombre: appt.client_name.split(' ')[0],
    nombre_completo: appt.client_name,
    servicio: appt.service_name,
    fecha: fmtDate(appt.date),
    hora: `${appt.start_time} hs`,
    sena: fmtMoney(appt.deposit_paid),
    saldo: fmtMoney(appt.balance),
    negocio: settings.get('business_name'),
    direccion: settings.get('business_address'),
    telefono: settings.get('business_phone'),
    indicaciones: settings.get('wa_info'),
  };
}

const FIELD_NAMES = ['nombre', 'nombre_completo', 'servicio', 'fecha', 'hora', 'sena', 'saldo', 'negocio', 'direccion', 'telefono', 'indicaciones'];

function templateParams(fields) {
  return settings
    .get('wa_template_vars')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((name) => {
      if (!FIELD_NAMES.includes(name)) throw new HttpError(400, `Variable de plantilla desconocida: "${name}"`);
      return { type: 'text', text: oneLine(fields[name]) };
    });
}

async function sendTemplate(to, params) {
  const res = await http.json(`${GRAPH}/${encodeURIComponent(settings.get('wa_phone_number_id'))}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.get('wa_token')}` },
    body: {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: settings.get('wa_template_name'),
        language: { code: settings.get('wa_template_lang') || 'es_AR' },
        components: params.length ? [{ type: 'body', parameters: params }] : [],
      },
    },
  });
  return res && res.messages && res.messages[0] ? res.messages[0].id : null;
}

/**
 * Envía la confirmación del turno por WhatsApp. Por defecto no reenvía si ya se mandó.
 * Nunca lanza error salvo con { throwErrors: true } (envío manual desde el panel).
 */
async function sendConfirmation(appointmentId, { force = false, throwErrors = false } = {}) {
  try {
    if (!isConfigured()) throw new HttpError(400, 'WhatsApp no está configurado');
    const appt = agenda.getAppointment(appointmentId);
    if (appt.wa_status === 'sent' && !force) return { skipped: true };
    const to = toWhatsAppNumber(appt.client_phone);
    if (!to) throw new HttpError(400, `El teléfono "${appt.client_phone || ''}" no es un celular válido`);
    const messageId = await sendTemplate(to, templateParams(fieldsFor(appt)));
    db.run(`UPDATE appointments SET wa_status = 'sent', wa_error = NULL, wa_sent_at = datetime('now') WHERE id = ?`, appt.id);
    log('whatsapp', 'info', `Confirmación enviada a ${appt.client_name} (${to}) - turno #${appt.id}${messageId ? ` [${messageId}]` : ''}`);
    return { sent: true, to };
  } catch (err) {
    const msg = err.data && err.data.error ? err.data.error.message || err.message : err.message;
    db.run(`UPDATE appointments SET wa_status = 'error', wa_error = ? WHERE id = ?`, String(msg).slice(0, 500), appointmentId);
    log('whatsapp', 'error', `No se pudo enviar la confirmación del turno #${appointmentId}: ${msg}`);
    if (throwErrors) throw err instanceof HttpError ? err : new HttpError(502, `WhatsApp: ${msg}`);
    return { error: msg };
  }
}

// Se llama cuando un turno queda confirmado por el pago de la seña.
function notifyConfirmed(appointmentId) {
  if (!isEnabled()) return;
  const appt = db.one('SELECT status, wa_status FROM appointments WHERE id = ?', appointmentId);
  if (!appt || appt.status !== 'confirmed' || appt.wa_status === 'sent') return;
  sendConfirmation(appointmentId).catch(() => {});
}

async function sendTest(phone) {
  if (!isConfigured()) throw new HttpError(400, 'Completá el token, el ID del número y el nombre de la plantilla');
  const to = toWhatsAppNumber(phone);
  if (!to) throw new HttpError(400, 'El teléfono no es un celular válido');
  const sample = {
    nombre: 'María',
    nombre_completo: 'María Pérez',
    servicio: 'Bronceado orgánico',
    fecha: fmtDate(new Date().toISOString().slice(0, 10)),
    hora: '10:30 hs',
    sena: '$8.000',
    saldo: '$17.000',
    negocio: settings.get('business_name'),
    direccion: settings.get('business_address'),
    telefono: settings.get('business_phone'),
    indicaciones: settings.get('wa_info'),
  };
  try {
    await sendTemplate(to, templateParams(sample));
  } catch (err) {
    const msg = err.data && err.data.error ? err.data.error.message || err.message : err.message;
    throw new HttpError(502, `WhatsApp: ${msg}`);
  }
  return { sent: true, to };
}

// Texto completo para enviar a mano por wa.me (sin las limitaciones de la plantilla).
function manualMessage(appt) {
  const f = fieldsFor(appt);
  const lines = [
    `¡Hola ${f.nombre}! Tu turno está confirmado ✅`,
    '',
    `📅 ${f.fecha}`,
    `🕐 ${f.hora}`,
    `💆 ${f.servicio}`,
  ];
  if (appt.deposit_paid > 0) lines.push(`💳 Seña recibida: ${f.sena} · Saldo a abonar: ${f.saldo}`);
  if (f.direccion) lines.push(`📍 ${f.direccion}`);
  if (f.indicaciones) lines.push('', 'Para tener en cuenta:', f.indicaciones);
  lines.push('', `¡Te esperamos! ${f.negocio || ''}`.trim());
  return lines.join('\n');
}

function manualLink(appt) {
  const to = toWhatsAppNumber(appt.client_phone);
  return to ? `https://wa.me/${to}?text=${encodeURIComponent(manualMessage(appt))}` : null;
}

module.exports = { FIELD_NAMES, isConfigured, isEnabled, toWhatsAppNumber, sendConfirmation, notifyConfirmed, sendTest, manualMessage, manualLink };
