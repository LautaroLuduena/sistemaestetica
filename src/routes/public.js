const express = require('express');
const db = require('../db');
const settings = require('../settings');
const agenda = require('../services/agenda');
const payments = require('../services/payments');
const mp = require('../services/mercadopago');
const { log } = require('../services/log');
const { HttpError } = require('../util');

const router = express.Router();

function publicBooking(a) {
  return {
    token: a.public_token,
    status: a.status,
    service: a.service_name,
    date: a.date,
    time: a.start_time,
    end_time: a.end_time,
    price: a.price,
    deposit_amount: a.deposit_amount,
    deposit_paid: a.deposit_paid,
    client_name: a.client_name,
    expires_at: a.expires_at ? `${a.expires_at.replace(' ', 'T')}Z` : null,
    alert: a.alert ? 'Recibimos tu pago pero el horario ya no estaba disponible. Nos vamos a comunicar con vos para reprogramar.' : null,
  };
}

router.get('/info', (req, res) => {
  res.json({
    business_name: settings.get('business_name'),
    business_phone: settings.get('business_phone'),
    business_address: settings.get('business_address'),
    terms: settings.get('booking_terms'),
    hold_minutes: settings.getInt('booking_hold_min'),
    services: db.all('SELECT id, name, description, duration_min, price, deposit_amount FROM services WHERE active = 1 ORDER BY sort, name'),
    open_days: agenda.openDays(),
  });
});

router.get('/slots', (req, res) => {
  res.json({ slots: agenda.availableSlots(String(req.query.date || ''), Number(req.query.serviceId)) });
});

router.post('/bookings', async (req, res) => {
  const { serviceId, date, time, name, phone, email, notes } = req.body || {};
  const service = db.one('SELECT deposit_amount FROM services WHERE id = ? AND active = 1', Number(serviceId));
  if (service && service.deposit_amount > 0 && !mp.isConfigured()) {
    throw new HttpError(503, 'Las reservas online no están disponibles en este momento. Comunicate con nosotros.');
  }
  const appt = agenda.createWebBooking({ serviceId: Number(serviceId), date, time, name, phone, email, notes });
  if (appt.status !== 'pending_payment') return res.status(201).json({ booking: publicBooking(appt) });
  try {
    const pref = await payments.depositCheckout(appt.id, { holdMinutes: settings.getInt('booking_hold_min') });
    res.status(201).json({ booking: publicBooking(agenda.getAppointment(appt.id)), init_point: pref.init_point });
  } catch (err) {
    db.run(`UPDATE appointments SET status = 'cancelled', notes = TRIM(COALESCE(notes, '') || ' [No se pudo generar el pago]') WHERE id = ?`, appt.id);
    log('mercadopago', 'error', `No se pudo crear el link de seña del turno #${appt.id}: ${err.message}`);
    throw new HttpError(502, 'No pudimos generar el pago de la seña. Probá de nuevo en unos minutos.');
  }
});

router.get('/bookings/:token', (req, res) => {
  res.json({ booking: publicBooking(agenda.getByToken(req.params.token)) });
});

// Vuelve a generar el link de pago (si la clienta cerró la ventana antes de pagar).
router.post('/bookings/:token/pay', async (req, res) => {
  agenda.expirePending();
  const appt = agenda.getByToken(req.params.token);
  if (appt.status !== 'pending_payment') throw new HttpError(409, 'Esta reserva ya no está pendiente de pago');
  const remainingMin = Math.max(1, Math.ceil((Date.parse(`${appt.expires_at.replace(' ', 'T')}Z`) - Date.now()) / 60e3));
  const pref = await payments.depositCheckout(appt.id, { holdMinutes: remainingMin });
  res.json({ init_point: pref.init_point });
});

// Al volver de Mercado Pago se verifica el pago sin esperar al webhook.
router.post('/bookings/:token/check', async (req, res) => {
  const appt = agenda.getByToken(req.params.token);
  const paymentId = String((req.body && req.body.paymentId) || '').replace(/\D/g, '');
  if (paymentId && mp.isConfigured()) {
    try {
      const result = await payments.processPayment(paymentId);
      if (result.reference && result.reference !== `appt:${appt.id}`) throw new HttpError(400, 'El pago no corresponde a esta reserva');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      log('mercadopago', 'error', `Error verificando el pago ${paymentId}: ${err.message}`);
    }
  }
  res.json({ booking: publicBooking(agenda.getAppointment(appt.id)) });
});

module.exports = router;
