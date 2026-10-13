const db = require('../db');
const mp = require('./mercadopago');
const agenda = require('./agenda');
const cash = require('./cash');
const settings = require('../settings');
const whatsapp = require('./whatsapp');
const { log } = require('./log');
const { conflict, round2 } = require('../util');

// Genera el link de pago de la seña de un turno.
async function depositCheckout(appointmentId, { holdMinutes } = {}) {
  const appt = agenda.getAppointment(appointmentId);
  const pending = round2(appt.deposit_amount - appt.deposit_paid);
  if (pending <= 0) throw conflict('Este turno no tiene seña pendiente');
  const pref = await mp.createPreference({
    title: `Seña ${appt.service_name} - ${appt.date} ${appt.start_time}`,
    amount: pending,
    externalReference: `appt:${appt.id}`,
    payer: { name: appt.client_name, email: appt.client_email, phone: appt.client_phone },
    returnPath: `/reserva.html?t=${appt.public_token}`,
    expiresInMin: holdMinutes,
    depositMode: true,
  });
  db.run(`UPDATE appointments SET mp_preference_id = ?, updated_at = datetime('now') WHERE id = ?`, pref.id, appt.id);
  return pref;
}

// Genera el link/QR de cobro de una venta pendiente de la caja.
async function saleCheckout(saleId) {
  const sale = cash.getSale(saleId);
  if (sale.status !== 'pending') throw conflict('La venta no está pendiente de pago');
  const pref = await mp.createPreference({
    title: `${settings.get('business_name') || 'Compra'} - Venta #${sale.id}`,
    amount: sale.total,
    externalReference: `sale:${sale.id}`,
    returnPath: '/pago.html',
    expiresInMin: 60,
  });
  db.run('UPDATE sales SET mp_preference_id = ?, mp_init_point = ? WHERE id = ?', pref.id, pref.init_point, sale.id);
  return pref;
}

/**
 * Consulta un pago en Mercado Pago y, si está aprobado, lo aplica (una sola vez) a lo que corresponda.
 * Se llama desde el webhook y también cuando la clienta vuelve del checkout (por si el webhook tarda).
 */
async function processPayment(paymentId) {
  return applyPayment(await mp.getPayment(paymentId));
}

// Registra un pago ya obtenido de Mercado Pago y, si está aprobado, lo aplica una sola vez.
function applyPayment(payment) {
  const id = String(payment.id);
  const ref = String(payment.external_reference || '');
  const amount = round2(payment.transaction_amount || 0);

  db.run(
    `INSERT INTO mp_payments (payment_id, status, external_reference, amount, raw) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(payment_id) DO UPDATE SET status = excluded.status, raw = excluded.raw, updated_at = datetime('now')`,
    id,
    payment.status,
    ref,
    amount,
    JSON.stringify({ status: payment.status, status_detail: payment.status_detail, payment_method_id: payment.payment_method_id, date_approved: payment.date_approved })
  );

  if (payment.status !== 'approved') return { status: payment.status, reference: ref };

  const result = db.tx(() => {
    const row = db.one('SELECT applied FROM mp_payments WHERE payment_id = ?', id);
    if (row.applied) return { status: 'approved', reference: ref, alreadyApplied: true };
    let target = null;
    const [kind, rawId] = ref.split(':');
    const targetId = Number(rawId);
    if (kind === 'appt' && targetId && db.one('SELECT 1 FROM appointments WHERE id = ?', targetId)) {
      target = cash.registerMpDeposit(targetId, amount, id);
    } else if (kind === 'sale' && targetId && db.one('SELECT 1 FROM sales WHERE id = ?', targetId)) {
      const sale = cash.getSale(targetId);
      if (sale.status === 'pending') {
        target = cash.finalizeSale(targetId, { mpPaymentId: id });
      } else {
        // Venta anulada o ya cobrada por otro medio: se deja registrado para devolver.
        cash.addMovement({ type: 'income', method: 'mercadopago', amount, reference: `mp:${id}`, requireSession: false, description: `Pago MP ${id} de venta #${targetId} (${sale.status}): revisar` });
        log('mercadopago', 'warn', `Pago ${id} acreditado para la venta #${targetId} que estaba ${sale.status}`);
      }
    } else {
      log('mercadopago', 'warn', `Pago ${id} aprobado con referencia desconocida "${ref}"`);
    }
    db.run('UPDATE mp_payments SET applied = 1 WHERE payment_id = ?', id);
    return { status: 'approved', reference: ref, target };
  });
  if (!result.alreadyApplied) {
    log('mercadopago', 'info', `Pago ${id} aprobado ($${amount}) aplicado a ${ref}`);
    if (ref.startsWith('appt:')) whatsapp.notifyConfirmed(Number(ref.split(':')[1]));
  }
  return result;
}

/**
 * Busca en Mercado Pago los pagos de una reserva o venta pendiente y aplica los aprobados.
 * Así el sistema no depende solo del webhook (que puede fallar o no estar configurado).
 */
async function checkReference(kind, id) {
  const ref = `${kind}:${id}`;
  const found = await mp.searchPayments(ref);
  const table = kind === 'appt' ? 'appointments' : 'sales';
  db.run(`UPDATE ${table} SET mp_checked_at = datetime('now') WHERE id = ?`, id);
  let approved = 0;
  for (const p of found) {
    if (String(p.external_reference) !== ref) continue;
    const res = applyPayment(p);
    if (res.status === 'approved' && !res.alreadyApplied) approved++;
  }
  return { reference: ref, payments: found.length, approved };
}

let checking = false;

// Revisa las reservas y ventas que esperan un pago de Mercado Pago. Se ejecuta cada minuto.
async function reconcilePending({ force = false } = {}) {
  if (checking || !mp.isConfigured()) return { skipped: true };
  if (!force && settings.get('mp_auto_check') !== '1') return { skipped: true };
  checking = true;
  const summary = { checked: 0, approved: 0, errors: 0 };
  try {
    agenda.expirePending();
    // Reservas esperando la seña, y las vencidas hace poco (por si el pago llegó justo al límite).
    const appts = db.all(
      `SELECT id FROM appointments
       WHERE mp_preference_id IS NOT NULL AND deposit_paid < deposit_amount
         AND (status = 'pending_payment' OR (status IN ('expired', 'confirmed') AND updated_at > datetime('now', '-6 hours')))
         AND (mp_checked_at IS NULL OR mp_checked_at < datetime('now', '-50 seconds'))
       ORDER BY id DESC LIMIT 40`
    );
    const sales = db.all(
      `SELECT id FROM sales WHERE status = 'pending' AND mp_preference_id IS NOT NULL AND created_at > datetime('now', '-2 days')
         AND (mp_checked_at IS NULL OR mp_checked_at < datetime('now', '-50 seconds'))
       ORDER BY id DESC LIMIT 40`
    );
    for (const [kind, rows] of [['appt', appts], ['sale', sales]]) {
      for (const r of rows) {
        try {
          const res = await checkReference(kind, r.id);
          summary.checked++;
          summary.approved += res.approved;
        } catch (err) {
          summary.errors++;
          log('mercadopago', 'error', `Verificación automática de ${kind}:${r.id}: ${err.message}`);
        }
      }
    }
    if (summary.approved) log('mercadopago', 'info', `Verificación automática: ${summary.approved} pago(s) encontrados y aplicados`);
    return summary;
  } finally {
    checking = false;
  }
}

// Cancela un turno y, si se pide, devuelve la seña pagada por Mercado Pago.
async function cancelAppointment(appointmentId, { refund = false } = {}, userId = null) {
  const appt = agenda.getAppointment(appointmentId);
  if (refund) {
    if (!appt.mp_payment_id) throw conflict('La seña no se pagó por Mercado Pago: devolvela manualmente y registrá un egreso');
    const mpRow = db.one('SELECT * FROM mp_payments WHERE payment_id = ?', appt.mp_payment_id);
    if (mpRow && mpRow.refunded) throw conflict('La seña ya fue devuelta');
    await mp.refund(appt.mp_payment_id);
    db.tx(() => {
      db.run('UPDATE mp_payments SET refunded = 1 WHERE payment_id = ?', appt.mp_payment_id);
      db.run(`UPDATE appointments SET deposit_paid = 0, updated_at = datetime('now') WHERE id = ?`, appt.id);
      cash.addMovement(
        {
          type: 'refund',
          method: 'mercadopago',
          amount: -appt.deposit_paid,
          appointmentId: appt.id,
          reference: `mp:${appt.mp_payment_id}`,
          description: `Devolución seña turno ${appt.date} ${appt.start_time} - ${appt.client_name}`,
          requireSession: false,
        },
        userId
      );
    });
    log('mercadopago', 'info', `Seña devuelta (pago ${appt.mp_payment_id}) del turno #${appt.id}`);
  }
  return agenda.setStatus(appt.id, 'cancelled');
}

module.exports = { depositCheckout, saleCheckout, processPayment, applyPayment, checkReference, reconcilePending, cancelAppointment };
