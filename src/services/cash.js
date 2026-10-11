const db = require('../db');
const agenda = require('./agenda');
const stock = require('./stock');
const { badRequest, notFound, conflict, round2, money, int } = require('../util');

// Medios de pago. "mp_link" genera un link/QR de Mercado Pago y la venta queda pendiente hasta que se acredita.
const METHODS = {
  efectivo: 'Efectivo',
  mercadopago: 'Mercado Pago',
  debito: 'Débito',
  credito: 'Crédito',
  transferencia: 'Transferencia',
};

const MOVEMENT_TYPES = {
  sale: 'Venta',
  deposit: 'Seña',
  income: 'Ingreso',
  expense: 'Egreso',
  refund: 'Devolución',
  sale_cancel: 'Anulación de venta',
};

function currentSession() {
  return db.one('SELECT * FROM cash_sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1') || null;
}

function requireOpen() {
  const s = currentSession();
  if (!s) throw conflict('La caja está cerrada. Abrila para poder cobrar.');
  return s;
}

function openSession({ openingAmount = 0, notes = null }, userId) {
  return db.tx(() => {
    if (currentSession()) throw conflict('Ya hay una caja abierta');
    const res = db.run('INSERT INTO cash_sessions (opened_by, opening_amount, notes) VALUES (?, ?, ?)', userId, money(openingAmount || 0, 'monto inicial'), notes);
    return db.one('SELECT * FROM cash_sessions WHERE id = ?', Number(res.lastInsertRowid));
  });
}

function addMovement({ type, method, amount, description = null, saleId = null, appointmentId = null, reference = null, requireSession = true }, userId = null) {
  if (!MOVEMENT_TYPES[type]) throw badRequest('Tipo de movimiento inválido');
  if (!METHODS[method]) throw badRequest('Medio de pago inválido');
  const session = requireSession ? requireOpen() : currentSession();
  const res = db.run(
    `INSERT INTO cash_movements (cash_session_id, type, payment_method, amount, description, sale_id, appointment_id, reference, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    session ? session.id : null,
    type,
    method,
    round2(amount),
    description,
    saleId,
    appointmentId,
    reference,
    userId
  );
  return Number(res.lastInsertRowid);
}

// Ingresos/egresos manuales (ej. pago a proveedor, retiro, cambio).
function manualMovement({ type, method = 'efectivo', amount, description }, userId) {
  if (!['income', 'expense'].includes(type)) throw badRequest('Tipo inválido');
  const value = money(amount);
  if (!value) throw badRequest('Ingresá un importe');
  if (!String(description || '').trim()) throw badRequest('Ingresá una descripción');
  return db.tx(() => addMovement({ type, method, amount: type === 'expense' ? -value : value, description: description.trim() }, userId));
}

function summary(sessionId) {
  const session = db.one('SELECT * FROM cash_sessions WHERE id = ?', sessionId);
  if (!session) throw notFound('Caja no encontrada');
  const byMethod = {};
  for (const m of Object.keys(METHODS)) byMethod[m] = 0;
  const rows = db.all('SELECT payment_method, type, SUM(amount) AS total, COUNT(*) AS n FROM cash_movements WHERE cash_session_id = ? GROUP BY payment_method, type', sessionId);
  const byType = {};
  for (const r of rows) {
    byMethod[r.payment_method] = round2((byMethod[r.payment_method] || 0) + r.total);
    byType[r.type] = round2((byType[r.type] || 0) + r.total);
  }
  const expectedCash = round2(session.opening_amount + (byMethod.efectivo || 0));
  const total = round2(Object.values(byMethod).reduce((a, b) => a + b, 0));
  return { session, byMethod, byType, expectedCash, total };
}

function closeSession({ countedAmount, notes = null }, userId) {
  return db.tx(() => {
    const session = requireOpen();
    const counted = money(countedAmount, 'efectivo contado');
    const { expectedCash } = summary(session.id);
    db.run(
      `UPDATE cash_sessions SET closed_at = datetime('now'), closed_by = ?, counted_amount = ?, expected_cash = ?, difference = ?,
              notes = COALESCE(?, notes) WHERE id = ?`,
      userId,
      counted,
      expectedCash,
      round2(counted - expectedCash),
      notes,
      session.id
    );
    return summary(session.id);
  });
}

function movements(sessionId) {
  return db.all(
    `SELECT m.*, u.username FROM cash_movements m LEFT JOIN users u ON u.id = m.user_id
     WHERE ${sessionId ? 'm.cash_session_id = ?' : 'm.cash_session_id IS NULL'} ORDER BY m.id DESC`,
    ...(sessionId ? [sessionId] : [])
  );
}

function sessions(limit = 50) {
  return db.all(
    `SELECT s.*, uo.username AS opened_by_name, uc.username AS closed_by_name
     FROM cash_sessions s LEFT JOIN users uo ON uo.id = s.opened_by LEFT JOIN users uc ON uc.id = s.closed_by
     ORDER BY s.id DESC LIMIT ?`,
    limit
  );
}

// ---------- Señas cobradas en el local ----------

function chargeDeposit(appointmentId, { amount, method }, userId) {
  if (!METHODS[method]) throw badRequest('Medio de pago inválido');
  return db.tx(() => {
    const appt = agenda.getAppointment(appointmentId);
    if (appt.status === 'cancelled') throw conflict('El turno está cancelado');
    const value = money(amount ?? Math.max(0, appt.deposit_amount - appt.deposit_paid));
    if (!value) throw badRequest('Ingresá el importe de la seña');
    addMovement(
      { type: 'deposit', method, amount: value, appointmentId: appt.id, description: `Seña turno ${appt.date} ${appt.start_time} - ${appt.client_name}` },
      userId
    );
    return agenda.applyDeposit(appt.id, value);
  });
}

// Seña acreditada por Mercado Pago (webhook). Se registra en la caja abierta, o queda "sin caja" si está cerrada.
function registerMpDeposit(appointmentId, amount, paymentId) {
  return db.tx(() => {
    const appt = agenda.applyDeposit(appointmentId, amount, { mpPaymentId: paymentId });
    addMovement({
      type: 'deposit',
      method: 'mercadopago',
      amount,
      appointmentId: appt.id,
      reference: `mp:${paymentId}`,
      description: `Seña online turno ${appt.date} ${appt.start_time} - ${appt.client_name}`,
      requireSession: false,
    });
    return appt;
  });
}

// ---------- Ventas ----------

/**
 * items: [{ productId, quantity, unitPrice? } | { appointmentId, amount? } | { serviceId, unitPrice?, quantity? } | { description, unitPrice, quantity? }]
 */
function buildItems(items) {
  if (!Array.isArray(items) || !items.length) throw badRequest('La venta no tiene ítems');
  return items.map((it) => {
    if (it.productId) {
      const p = stock.getProduct(it.productId);
      const quantity = int(it.quantity ?? 1);
      if (quantity <= 0) throw badRequest('La cantidad debe ser mayor a cero');
      const unit = it.unitPrice !== undefined && it.unitPrice !== null && it.unitPrice !== '' ? money(it.unitPrice, 'precio') : p.price;
      return { product_id: p.id, description: p.name, quantity, unit_price: unit, subtotal: round2(unit * quantity) };
    }
    if (it.appointmentId) {
      const a = agenda.getAppointment(it.appointmentId);
      if (a.status === 'cancelled') throw conflict('El turno está cancelado');
      const amount = it.amount !== undefined && it.amount !== null && it.amount !== '' ? money(it.amount) : a.balance;
      return {
        appointment_id: a.id,
        service_id: a.service_id,
        description: `${a.service_name} (turno ${a.date} ${a.start_time})${a.deposit_paid ? ` - seña descontada $${a.deposit_paid}` : ''}`,
        quantity: 1,
        unit_price: amount,
        subtotal: amount,
      };
    }
    if (it.serviceId) {
      const s = db.one('SELECT * FROM services WHERE id = ?', it.serviceId);
      if (!s) throw notFound('El servicio no existe');
      const quantity = int(it.quantity ?? 1);
      if (quantity <= 0) throw badRequest('La cantidad debe ser mayor a cero');
      const unit = it.unitPrice !== undefined && it.unitPrice !== null && it.unitPrice !== '' ? money(it.unitPrice, 'precio') : s.price;
      return { service_id: s.id, description: s.name, quantity, unit_price: unit, subtotal: round2(unit * quantity) };
    }
    const description = String(it.description || '').trim();
    if (!description) throw badRequest('Falta la descripción del ítem');
    const quantity = int(it.quantity ?? 1);
    if (quantity <= 0) throw badRequest('La cantidad debe ser mayor a cero');
    const unit = money(it.unitPrice, 'precio');
    return { description, quantity, unit_price: unit, subtotal: round2(unit * quantity) };
  });
}

function createSale({ items, discount = 0, method, clientId = null, notes = null }, userId) {
  const isLink = method === 'mp_link';
  if (!isLink && !METHODS[method]) throw badRequest('Medio de pago inválido');
  return db.tx(() => {
    const session = requireOpen();
    const lines = buildItems(items);
    const subtotal = round2(lines.reduce((a, l) => a + l.subtotal, 0));
    const disc = money(discount || 0, 'descuento');
    if (disc > subtotal) throw badRequest('El descuento no puede superar el total');
    const total = round2(subtotal - disc);
    if (isLink && total <= 0) throw badRequest('El total debe ser mayor a cero para cobrar con Mercado Pago');
    const apptLine = lines.find((l) => l.appointment_id);
    let client = clientId ? Number(clientId) : null;
    if (!client && apptLine) client = agenda.getAppointment(apptLine.appointment_id).client_id;

    // Para links de pago, se verifica el stock ahora (se descuenta al acreditarse).
    if (isLink) {
      for (const l of lines.filter((x) => x.product_id)) {
        const p = stock.getProduct(l.product_id);
        if (p.stock < l.quantity) throw conflict(`Stock insuficiente de "${p.name}" (disponible: ${p.stock})`);
      }
    }

    const res = db.run(
      `INSERT INTO sales (cash_session_id, client_id, appointment_id, subtotal, discount, total, payment_method, status, notes, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      session.id,
      client,
      apptLine ? apptLine.appointment_id : null,
      subtotal,
      disc,
      total,
      isLink ? 'mercadopago' : method,
      String(notes || '').trim() || null,
      userId
    );
    const saleId = Number(res.lastInsertRowid);
    for (const l of lines) {
      db.run(
        `INSERT INTO sale_items (sale_id, product_id, service_id, appointment_id, description, quantity, unit_price, subtotal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        saleId,
        l.product_id ?? null,
        l.service_id ?? null,
        l.appointment_id ?? null,
        l.description,
        l.quantity,
        l.unit_price,
        l.subtotal
      );
    }
    if (!isLink) finalizeSale(saleId, { userId });
    return getSale(saleId);
  });
}

// Marca la venta como cobrada: descuenta stock, registra el movimiento de caja y el saldo del turno.
function finalizeSale(saleId, { userId = null, mpPaymentId = null } = {}) {
  return db.tx(() => {
    const sale = getSale(saleId);
    if (sale.status === 'paid') return sale;
    if (sale.status === 'cancelled') throw conflict('La venta está anulada');
    for (const it of sale.items) {
      if (it.product_id) {
        stock.change(it.product_id, {
          delta: -it.quantity,
          type: 'sale',
          reason: `Venta #${sale.id}`,
          reference: `sale:${sale.id}`,
          userId,
          allowNegative: Boolean(mpPaymentId), // si ya se cobró online, no se puede rechazar
        });
      }
      if (it.appointment_id) {
        db.run(
          `UPDATE appointments SET balance_paid = balance_paid + ?, status = CASE WHEN status IN ('confirmed', 'pending_payment', 'expired') THEN 'completed' ELSE status END,
                  alert = NULL, expires_at = NULL, updated_at = datetime('now') WHERE id = ?`,
          it.subtotal,
          it.appointment_id
        );
      }
    }
    db.run(`UPDATE sales SET status = 'paid', paid_at = datetime('now'), mp_payment_id = COALESCE(?, mp_payment_id) WHERE id = ?`, mpPaymentId, sale.id);
    if (sale.total > 0) {
      addMovement(
        {
          type: 'sale',
          method: sale.payment_method,
          amount: sale.total,
          saleId: sale.id,
          reference: mpPaymentId ? `mp:${mpPaymentId}` : null,
          description: `Venta #${sale.id}: ${sale.items.map((i) => `${i.quantity}x ${i.description}`).join(', ')}`.slice(0, 300),
          requireSession: !mpPaymentId,
        },
        userId
      );
    }
    return getSale(sale.id);
  });
}

function cancelSale(saleId, userId) {
  return db.tx(() => {
    const sale = getSale(saleId);
    if (sale.status === 'cancelled') throw conflict('La venta ya está anulada');
    if (sale.status === 'paid') {
      if (sale.payment_method === 'mercadopago' && sale.mp_payment_id) {
        throw conflict('La venta se cobró con Mercado Pago: hacé la devolución desde Mercado Pago y registrá un egreso');
      }
      requireOpen();
      for (const it of sale.items) {
        if (it.product_id) {
          stock.change(it.product_id, { delta: it.quantity, type: 'sale_cancel', reason: `Anulación venta #${sale.id}`, reference: `sale:${sale.id}`, userId });
        }
        if (it.appointment_id) {
          db.run(
            `UPDATE appointments SET balance_paid = MAX(0, balance_paid - ?), status = CASE WHEN status = 'completed' THEN 'confirmed' ELSE status END,
                    updated_at = datetime('now') WHERE id = ?`,
            it.subtotal,
            it.appointment_id
          );
        }
      }
      if (sale.total > 0) {
        addMovement({ type: 'sale_cancel', method: sale.payment_method, amount: -sale.total, saleId: sale.id, description: `Anulación venta #${sale.id}` }, userId);
      }
    }
    db.run(`UPDATE sales SET status = 'cancelled' WHERE id = ?`, sale.id);
    return getSale(sale.id);
  });
}

function getSale(id) {
  const sale = db.one(
    `SELECT s.*, c.name AS client_name FROM sales s LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?`,
    id
  );
  if (!sale) throw notFound('La venta no existe');
  sale.items = db.all('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id', id);
  return sale;
}

function listSales({ sessionId, status, limit = 200 }) {
  const where = [];
  const params = [];
  if (sessionId) {
    where.push('s.cash_session_id = ?');
    params.push(sessionId);
  }
  if (status) {
    where.push('s.status = ?');
    params.push(status);
  }
  return db.all(
    `SELECT s.*, c.name AS client_name,
            (SELECT GROUP_CONCAT(quantity || 'x ' || description, ', ') FROM sale_items WHERE sale_id = s.id) AS detail
     FROM sales s LEFT JOIN clients c ON c.id = s.client_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.id DESC LIMIT ?`,
    ...params,
    limit
  );
}

module.exports = {
  METHODS,
  MOVEMENT_TYPES,
  currentSession,
  openSession,
  closeSession,
  addMovement,
  manualMovement,
  summary,
  movements,
  sessions,
  chargeDeposit,
  registerMpDeposit,
  createSale,
  finalizeSale,
  cancelSale,
  getSale,
  listSales,
};
