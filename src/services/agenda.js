const db = require('../db');
const settings = require('../settings');
const {
  badRequest,
  notFound,
  conflict,
  round2,
  isDate,
  isTime,
  toMinutes,
  fromMinutes,
  nowInTz,
  addDays,
  weekday,
  sqlNow,
  token,
} = require('../util');

// Estados de un turno:
//  pending_payment: reservado desde la web, esperando la seña (bloquea el horario hasta expires_at)
//  confirmed:       seña pagada (o turno cargado por el local)
//  completed:       la clienta fue atendida
//  cancelled:       cancelado
//  expired:         no se pagó la seña a tiempo
//  no_show:         no se presentó
const STATUSES = ['pending_payment', 'confirmed', 'completed', 'cancelled', 'expired', 'no_show'];

// Turnos que ocupan lugar en la agenda.
const BUSY_SQL = `(status IN ('confirmed', 'completed') OR (status = 'pending_payment' AND (expires_at IS NULL OR expires_at > ?)))`;

function busyIntervals(date, excludeId = null) {
  return db
    .all(`SELECT id, start_time, end_time FROM appointments WHERE date = ? AND ${BUSY_SQL} AND id IS NOT ?`, date, sqlNow(), excludeId)
    .map((a) => ({ id: a.id, start: toMinutes(a.start_time), end: toMinutes(a.end_time) }));
}

// Máxima cantidad de turnos simultáneos dentro de [start, end).
function maxOverlap(intervals, start, end) {
  const overlapping = intervals.filter((a) => a.start < end && a.end > start);
  const points = [start, ...overlapping.map((a) => a.start).filter((s) => s > start)];
  let max = 0;
  for (const p of points) {
    const count = overlapping.filter((a) => a.start <= p && a.end > p).length;
    if (count > max) max = count;
  }
  return max;
}

function hoursFor(date) {
  if (db.one('SELECT 1 FROM blocked_dates WHERE date = ?', date)) return [];
  return db
    .all('SELECT start_time, end_time FROM business_hours WHERE weekday = ? ORDER BY start_time', weekday(date))
    .map((r) => ({ start: toMinutes(r.start_time), end: toMinutes(r.end_time) }));
}

function getService(serviceId, { activeOnly = false } = {}) {
  const service = db.one('SELECT * FROM services WHERE id = ?', serviceId);
  if (!service || (activeOnly && !service.active)) throw notFound('El servicio no existe');
  return service;
}

// Horarios disponibles para un servicio en una fecha (vista pública).
function availableSlots(date, serviceId) {
  if (!isDate(date)) throw badRequest('Fecha inválida');
  const service = getService(serviceId, { activeOnly: true });
  const tz = settings.get('timezone');
  const now = nowInTz(tz);
  const lastDate = addDays(now.date, settings.getInt('booking_window_days'));
  if (date < now.date || date > lastDate) return [];

  const step = Math.max(5, settings.getInt('slot_interval_min'));
  const capacity = Math.max(1, settings.getInt('capacity'));
  const minStart = date === now.date ? now.minutes + settings.getInt('min_advance_min') : -1;
  const busy = busyIntervals(date);
  const slots = [];

  for (const range of hoursFor(date)) {
    for (let start = range.start; start + service.duration_min <= range.end; start += step) {
      if (start < minStart) continue;
      if (maxOverlap(busy, start, start + service.duration_min) < capacity) {
        slots.push(fromMinutes(start));
      }
    }
  }
  return slots;
}

// Días (dentro de la ventana de reserva) en los que el local atiende.
function openDays() {
  const now = nowInTz(settings.get('timezone'));
  const days = [];
  for (let i = 0; i <= settings.getInt('booking_window_days'); i++) {
    const date = addDays(now.date, i);
    if (hoursFor(date).length) days.push(date);
  }
  return days;
}

function hasRoom(date, startTime, endTime, excludeId = null) {
  const capacity = Math.max(1, settings.getInt('capacity'));
  return maxOverlap(busyIntervals(date, excludeId), toMinutes(startTime), toMinutes(endTime)) < capacity;
}

function withinHours(date, startTime, endTime) {
  const s = toMinutes(startTime);
  const e = toMinutes(endTime);
  return hoursFor(date).some((r) => s >= r.start && e <= r.end);
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function upsertClient({ name, phone, email }) {
  const cleanPhone = normalizePhone(phone);
  const cleanEmail = String(email || '').trim().toLowerCase() || null;
  const cleanName = String(name || '').trim();
  let client = cleanPhone ? db.one('SELECT * FROM clients WHERE phone = ?', cleanPhone) : null;
  if (!client && cleanEmail) client = db.one('SELECT * FROM clients WHERE email = ?', cleanEmail);
  if (client) {
    db.run(
      'UPDATE clients SET name = ?, phone = COALESCE(?, phone), email = COALESCE(?, email) WHERE id = ?',
      cleanName || client.name,
      cleanPhone || null,
      cleanEmail,
      client.id
    );
    return client.id;
  }
  return Number(db.run('INSERT INTO clients (name, phone, email) VALUES (?, ?, ?)', cleanName, cleanPhone || null, cleanEmail).lastInsertRowid);
}

function getAppointment(id) {
  const appt = db.one(
    `SELECT a.*, c.name AS client_name, c.phone AS client_phone, c.email AS client_email,
            s.name AS service_name, s.duration_min
     FROM appointments a
     JOIN clients c ON c.id = a.client_id
     JOIN services s ON s.id = a.service_id
     WHERE a.id = ?`,
    id
  );
  if (!appt) throw notFound('El turno no existe');
  appt.balance = round2(Math.max(0, appt.price - appt.deposit_paid - appt.balance_paid));
  return appt;
}

function getByToken(publicToken) {
  const row = db.one('SELECT id FROM appointments WHERE public_token = ?', String(publicToken || ''));
  if (!row) throw notFound('Reserva no encontrada');
  return getAppointment(row.id);
}

// Reserva desde la web: queda "pendiente de pago" hasta que se acredite la seña.
function createWebBooking({ serviceId, date, time, name, phone, email, notes }) {
  if (!String(name || '').trim()) throw badRequest('Ingresá tu nombre');
  if (normalizePhone(phone).length < 8) throw badRequest('Ingresá un teléfono válido');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('El email no es válido');
  if (!isTime(time)) throw badRequest('Horario inválido');

  return db.tx(() => {
    const service = getService(serviceId, { activeOnly: true });
    if (!availableSlots(date, service.id).includes(time)) {
      throw conflict('Ese horario ya no está disponible, elegí otro');
    }
    const endTime = fromMinutes(toMinutes(time) + service.duration_min);
    const clientId = upsertClient({ name, phone, email });
    const deposit = round2(Math.min(service.deposit_amount, service.price || service.deposit_amount));
    const needsDeposit = deposit > 0;
    const holdMs = Math.max(5, settings.getInt('booking_hold_min')) * 60e3;
    const result = db.run(
      `INSERT INTO appointments
        (public_token, client_id, service_id, date, start_time, end_time, status, price, deposit_amount, source, notes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, ?)`,
      token(16),
      clientId,
      service.id,
      date,
      time,
      endTime,
      needsDeposit ? 'pending_payment' : 'confirmed',
      service.price,
      deposit,
      String(notes || '').trim() || null,
      needsDeposit ? sqlNow(holdMs) : null
    );
    return getAppointment(Number(result.lastInsertRowid));
  });
}

// Turno cargado por el local (teléfono, WhatsApp, mostrador).
function createManual({ serviceId, date, time, clientId, name, phone, email, notes, price, depositAmount, force }) {
  if (!isDate(date)) throw badRequest('Fecha inválida');
  if (!isTime(time)) throw badRequest('Horario inválido');
  return db.tx(() => {
    const service = getService(serviceId);
    const endTime = fromMinutes(toMinutes(time) + service.duration_min);
    if (!force) {
      if (!withinHours(date, time, endTime)) throw conflict('El horario está fuera del horario de atención');
      if (!hasRoom(date, time, endTime)) throw conflict('No hay lugar en ese horario');
    }
    let cid = clientId ? Number(clientId) : null;
    if (cid && !db.one('SELECT 1 FROM clients WHERE id = ?', cid)) throw notFound('La clienta no existe');
    if (!cid) {
      if (!String(name || '').trim()) throw badRequest('Falta el nombre de la clienta');
      cid = upsertClient({ name, phone, email });
    }
    const finalPrice = price !== undefined && price !== '' && price !== null ? round2(price) : service.price;
    const deposit = depositAmount !== undefined && depositAmount !== '' && depositAmount !== null ? round2(depositAmount) : service.deposit_amount;
    const result = db.run(
      `INSERT INTO appointments
        (public_token, client_id, service_id, date, start_time, end_time, status, price, deposit_amount, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, 'admin', ?)`,
      token(16),
      cid,
      service.id,
      date,
      time,
      endTime,
      finalPrice,
      deposit,
      String(notes || '').trim() || null
    );
    return getAppointment(Number(result.lastInsertRowid));
  });
}

function reschedule(id, { date, time, force }) {
  if (!isDate(date)) throw badRequest('Fecha inválida');
  if (!isTime(time)) throw badRequest('Horario inválido');
  return db.tx(() => {
    const appt = getAppointment(id);
    if (['cancelled', 'completed'].includes(appt.status)) throw conflict('No se puede reprogramar este turno');
    const endTime = fromMinutes(toMinutes(time) + appt.duration_min);
    if (!force) {
      if (!withinHours(date, time, endTime)) throw conflict('El horario está fuera del horario de atención');
      if (!hasRoom(date, time, endTime, appt.id)) throw conflict('No hay lugar en ese horario');
    }
    const revive = appt.status === 'expired' && appt.deposit_paid > 0;
    db.run(
      `UPDATE appointments SET date = ?, start_time = ?, end_time = ?, alert = NULL,
              status = CASE WHEN ? THEN 'confirmed' ELSE status END, updated_at = datetime('now')
       WHERE id = ?`,
      date,
      time,
      endTime,
      revive ? 1 : 0,
      appt.id
    );
    return getAppointment(appt.id);
  });
}

function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw badRequest('Estado inválido');
  return db.tx(() => {
    const appt = getAppointment(id);
    if (status === 'confirmed' && !['confirmed', 'completed'].includes(appt.status) && !hasRoom(appt.date, appt.start_time, appt.end_time, appt.id)) {
      throw conflict('No hay lugar en ese horario para confirmar el turno');
    }
    db.run(
      `UPDATE appointments SET status = ?, alert = CASE WHEN ? IN ('cancelled', 'confirmed') THEN NULL ELSE alert END,
              updated_at = datetime('now') WHERE id = ?`,
      status,
      status,
      appt.id
    );
    return getAppointment(appt.id);
  });
}

function updateNotes(id, notes) {
  getAppointment(id);
  db.run(`UPDATE appointments SET notes = ?, updated_at = datetime('now') WHERE id = ?`, String(notes || '').trim() || null, id);
  return getAppointment(id);
}

// Registra una seña pagada (por Mercado Pago o en el local) y confirma el turno si hay lugar.
function applyDeposit(id, amount, { mpPaymentId = null } = {}) {
  return db.tx(() => {
    const appt = getAppointment(id);
    let status = appt.status;
    let alert = appt.alert;
    if (['pending_payment', 'expired'].includes(appt.status)) {
      if (hasRoom(appt.date, appt.start_time, appt.end_time, appt.id)) {
        status = 'confirmed';
        alert = null;
      } else {
        status = 'expired';
        alert = 'Seña acreditada después de vencida la reserva y el horario ya fue ocupado: reprogramar o devolver la seña.';
      }
    } else if (appt.status === 'cancelled') {
      alert = 'Se acreditó una seña en un turno cancelado: revisar devolución.';
    }
    db.run(
      `UPDATE appointments SET deposit_paid = deposit_paid + ?, status = ?, alert = ?,
              mp_payment_id = COALESCE(?, mp_payment_id), expires_at = NULL, updated_at = datetime('now')
       WHERE id = ?`,
      round2(amount),
      status,
      alert,
      mpPaymentId,
      appt.id
    );
    return getAppointment(appt.id);
  });
}

function expirePending() {
  return db.run(`UPDATE appointments SET status = 'expired', updated_at = datetime('now')
                 WHERE status = 'pending_payment' AND expires_at IS NOT NULL AND expires_at <= ?`, sqlNow()).changes;
}

function list({ from, to, status, q }) {
  const where = [];
  const params = [];
  if (from) {
    where.push('a.date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('a.date <= ?');
    params.push(to);
  }
  if (status) {
    where.push('a.status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(c.name LIKE ? OR c.phone LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  return db
    .all(
      `SELECT a.*, c.name AS client_name, c.phone AS client_phone, c.email AS client_email, s.name AS service_name
       FROM appointments a JOIN clients c ON c.id = a.client_id JOIN services s ON s.id = a.service_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.date, a.start_time LIMIT 1000`,
      ...params
    )
    .map((a) => ({ ...a, balance: round2(Math.max(0, a.price - a.deposit_paid - a.balance_paid)) }));
}

module.exports = {
  STATUSES,
  maxOverlap,
  availableSlots,
  openDays,
  hasRoom,
  upsertClient,
  getAppointment,
  getByToken,
  createWebBooking,
  createManual,
  reschedule,
  setStatus,
  updateNotes,
  applyDeposit,
  expirePending,
  list,
  normalizePhone,
};
