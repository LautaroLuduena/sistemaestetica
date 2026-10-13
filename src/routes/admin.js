const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const settings = require('../settings');
const auth = require('../auth');
const agenda = require('../services/agenda');
const stock = require('../services/stock');
const cash = require('../services/cash');
const payments = require('../services/payments');
const mp = require('../services/mercadopago');
const tn = require('../services/tiendanube');
const whatsapp = require('../services/whatsapp');
const { recent } = require('../services/log');
const { badRequest, notFound, conflict, money, int, requireText, isDate, isTime, nowInTz } = require('../util');

const router = express.Router();
router.use(auth.requireAuth);

const uid = (req) => req.user.id;

// ---------- Panel ----------

router.get('/dashboard', (req, res) => {
  agenda.expirePending();
  const today = nowInTz(settings.get('timezone')).date;
  const session = cash.currentSession();
  res.json({
    today,
    appointments: agenda.list({ from: today, to: today }).filter((a) => !['cancelled', 'expired'].includes(a.status)),
    alerts: db.all(
      `SELECT a.id, a.date, a.start_time, a.alert, c.name AS client_name FROM appointments a JOIN clients c ON c.id = a.client_id
       WHERE a.alert IS NOT NULL ORDER BY a.date DESC LIMIT 20`
    ),
    lowStock: db.all('SELECT id, name, sku, stock, min_stock FROM products WHERE active = 1 AND stock <= min_stock ORDER BY stock, name LIMIT 50'),
    cash: session ? cash.summary(session.id) : null,
    integrations: { mercadopago: mp.isConfigured(), tiendanube: tn.isConfigured() },
    tnSyncErrors: db.one(`SELECT COUNT(*) AS n FROM products WHERE tn_sync_status = 'error'`).n,
  });
});

// ---------- Servicios ----------

function serviceInput(body) {
  const price = money(body.price ?? 0, 'precio');
  const deposit = money(body.deposit_amount ?? 0, 'seña');
  if (deposit > price && price > 0) throw badRequest('La seña no puede ser mayor al precio');
  const duration = int(body.duration_min, 'duración');
  if (duration < 5 || duration > 600) throw badRequest('La duración debe estar entre 5 y 600 minutos');
  return {
    name: requireText(body.name, 'el nombre'),
    description: String(body.description || '').trim() || null,
    duration_min: duration,
    price,
    deposit_amount: deposit,
    active: body.active === false || body.active === 0 ? 0 : 1,
    sort: Number(body.sort) || 0,
  };
}

router.get('/services', (req, res) => res.json(db.all('SELECT * FROM services ORDER BY sort, name')));

router.post('/services', (req, res) => {
  const s = serviceInput(req.body);
  const r = db.run(
    'INSERT INTO services (name, description, duration_min, price, deposit_amount, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?)',
    s.name, s.description, s.duration_min, s.price, s.deposit_amount, s.active, s.sort
  );
  res.status(201).json(db.one('SELECT * FROM services WHERE id = ?', Number(r.lastInsertRowid)));
});

router.put('/services/:id', (req, res) => {
  const s = serviceInput(req.body);
  const r = db.run(
    'UPDATE services SET name = ?, description = ?, duration_min = ?, price = ?, deposit_amount = ?, active = ?, sort = ? WHERE id = ?',
    s.name, s.description, s.duration_min, s.price, s.deposit_amount, s.active, s.sort, Number(req.params.id)
  );
  if (!r.changes) throw notFound();
  res.json(db.one('SELECT * FROM services WHERE id = ?', Number(req.params.id)));
});

router.delete('/services/:id', (req, res) => {
  const id = Number(req.params.id);
  const used = db.one('SELECT 1 FROM appointments WHERE service_id = ? UNION SELECT 1 FROM sale_items WHERE service_id = ?', id, id);
  if (used) {
    db.run('UPDATE services SET active = 0 WHERE id = ?', id);
    return res.json({ deactivated: true });
  }
  db.run('DELETE FROM services WHERE id = ?', id);
  res.json({ deleted: true });
});

// ---------- Horarios y feriados ----------

router.get('/hours', (req, res) => res.json(db.all('SELECT * FROM business_hours ORDER BY weekday, start_time')));

router.put('/hours', (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [];
  for (const r of rows) {
    if (!(Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday <= 6)) throw badRequest('Día inválido');
    if (!isTime(r.start_time) || !isTime(r.end_time) || r.start_time >= r.end_time) throw badRequest('Revisá los horarios: el inicio debe ser anterior al fin');
  }
  db.tx(() => {
    db.run('DELETE FROM business_hours');
    for (const r of rows) db.run('INSERT INTO business_hours (weekday, start_time, end_time) VALUES (?, ?, ?)', r.weekday, r.start_time, r.end_time);
  });
  res.json(db.all('SELECT * FROM business_hours ORDER BY weekday, start_time'));
});

router.get('/blocked-dates', (req, res) => res.json(db.all('SELECT * FROM blocked_dates WHERE date >= date(\'now\', \'-30 days\') ORDER BY date')));

router.post('/blocked-dates', (req, res) => {
  if (!isDate(req.body.date)) throw badRequest('Fecha inválida');
  db.run('INSERT INTO blocked_dates (date, reason) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET reason = excluded.reason', req.body.date, String(req.body.reason || '').trim() || null);
  res.status(201).json({ ok: true });
});

router.delete('/blocked-dates/:id', (req, res) => {
  db.run('DELETE FROM blocked_dates WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Turnos ----------

router.get('/appointments', (req, res) => {
  agenda.expirePending();
  res.json(agenda.list({ from: req.query.from, to: req.query.to, status: req.query.status, q: req.query.q }));
});

router.get('/appointments/slots', (req, res) => {
  res.json({ slots: agenda.availableSlots(String(req.query.date || ''), Number(req.query.serviceId)) });
});

router.post('/appointments', (req, res) => {
  res.status(201).json(agenda.createManual(req.body || {}));
});

router.get('/appointments/:id', (req, res) => {
  const appt = agenda.getAppointment(Number(req.params.id));
  appt.movements = db.all('SELECT * FROM cash_movements WHERE appointment_id = ? ORDER BY id', appt.id);
  appt.wa_link = whatsapp.manualLink(appt);
  appt.wa_configured = whatsapp.isConfigured();
  appt.mp_configured = mp.isConfigured();
  res.json(appt);
});

router.post('/appointments/:id/reschedule', (req, res) => {
  res.json(agenda.reschedule(Number(req.params.id), req.body || {}));
});

router.post('/appointments/:id/status', (req, res) => {
  const status = String((req.body && req.body.status) || '');
  if (status === 'cancelled') throw badRequest('Usá la opción Cancelar turno');
  res.json(agenda.setStatus(Number(req.params.id), status));
});

router.put('/appointments/:id/notes', (req, res) => {
  res.json(agenda.updateNotes(Number(req.params.id), req.body && req.body.notes));
});

router.post('/appointments/:id/cancel', async (req, res) => {
  res.json(await payments.cancelAppointment(Number(req.params.id), { refund: Boolean(req.body && req.body.refund) }, uid(req)));
});

router.post('/appointments/:id/deposit', (req, res) => {
  const { amount, method } = req.body || {};
  const appt = cash.chargeDeposit(Number(req.params.id), { amount, method }, uid(req));
  whatsapp.notifyConfirmed(appt.id);
  res.json(appt);
});

// Consulta en Mercado Pago si la seña del turno ya se pagó.
router.post('/appointments/:id/check-payment', async (req, res) => {
  const appt = agenda.getAppointment(Number(req.params.id));
  const result = await payments.checkReference('appt', appt.id);
  res.json({ ...result, appointment: agenda.getAppointment(appt.id) });
});

// Envía (o reenvía) la confirmación por WhatsApp.
router.post('/appointments/:id/whatsapp', async (req, res) => {
  res.json(await whatsapp.sendConfirmation(Number(req.params.id), { force: true, throwErrors: true }));
});

// Link de Mercado Pago para que la clienta pague la seña (para turnos cargados por teléfono/WhatsApp).
router.post('/appointments/:id/deposit-link', async (req, res) => {
  const appt = agenda.getAppointment(Number(req.params.id));
  const pref = await payments.depositCheckout(appt.id, { holdMinutes: 48 * 60 });
  const msg = `Hola ${appt.client_name}! Para confirmar tu turno de ${appt.service_name} el ${appt.date} a las ${appt.start_time} aboná la seña acá: ${pref.init_point}`;
  const phone = agenda.normalizePhone(appt.client_phone);
  res.json({
    init_point: pref.init_point,
    qr: await QRCode.toDataURL(pref.init_point, { margin: 1, width: 260 }),
    whatsapp: phone ? `https://wa.me/${phone.startsWith('54') ? phone : `54${phone}`}?text=${encodeURIComponent(msg)}` : null,
  });
});

// ---------- Clientas ----------

router.get('/clients', (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  res.json(
    db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id AND a.status IN ('confirmed','completed')) AS visits,
              (SELECT MAX(date) FROM appointments a WHERE a.client_id = c.id AND a.status IN ('confirmed','completed')) AS last_visit
       FROM clients c WHERE c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? ORDER BY c.name LIMIT 200`,
      q, q, q
    )
  );
});

router.put('/clients/:id', (req, res) => {
  const { name, phone, email, notes } = req.body || {};
  const r = db.run(
    'UPDATE clients SET name = ?, phone = ?, email = ?, notes = ? WHERE id = ?',
    requireText(name, 'el nombre'),
    agenda.normalizePhone(phone) || null,
    String(email || '').trim().toLowerCase() || null,
    String(notes || '').trim() || null,
    Number(req.params.id)
  );
  if (!r.changes) throw notFound();
  res.json(db.one('SELECT * FROM clients WHERE id = ?', Number(req.params.id)));
});

// ---------- Productos y stock ----------

function productInput(body) {
  return {
    sku: String(body.sku || '').trim() || null,
    name: requireText(body.name, 'el nombre'),
    description: String(body.description || '').trim() || null,
    price: money(body.price ?? 0, 'precio'),
    min_stock: Math.max(0, int(body.min_stock ?? 0, 'stock mínimo')),
    active: body.active === false || body.active === 0 ? 0 : 1,
    publish_online: body.publish_online === false || body.publish_online === 0 ? 0 : 1,
  };
}

function uniqueSku(sku, id = null) {
  if (sku && db.one('SELECT 1 FROM products WHERE sku = ? AND id IS NOT ?', sku, id)) throw conflict('Ya existe un producto con ese SKU');
}

router.get('/products', (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  res.json(db.all(`SELECT * FROM products WHERE name LIKE ? OR IFNULL(sku, '') LIKE ? ORDER BY active DESC, name`, q, q));
});

router.post('/products', (req, res) => {
  const p = productInput(req.body || {});
  uniqueSku(p.sku);
  const initial = req.body.stock ? int(req.body.stock, 'stock inicial') : 0;
  if (initial < 0) throw badRequest('El stock inicial no puede ser negativo');
  const id = db.tx(() => {
    const r = db.run(
      'INSERT INTO products (sku, name, description, price, min_stock, active, publish_online) VALUES (?, ?, ?, ?, ?, ?, ?)',
      p.sku, p.name, p.description, p.price, p.min_stock, p.active, p.publish_online
    );
    const newId = Number(r.lastInsertRowid);
    if (initial) stock.change(newId, { setTo: initial, type: 'initial', reason: 'Alta de producto', userId: uid(req) });
    return newId;
  });
  tn.schedulePush(id);
  res.status(201).json(stock.getProduct(id));
});

router.put('/products/:id', (req, res) => {
  const id = Number(req.params.id);
  stock.getProduct(id);
  const p = productInput(req.body || {});
  uniqueSku(p.sku, id);
  db.run(
    `UPDATE products SET sku = ?, name = ?, description = ?, price = ?, min_stock = ?, active = ?, publish_online = ?, updated_at = datetime('now') WHERE id = ?`,
    p.sku, p.name, p.description, p.price, p.min_stock, p.active, p.publish_online, id
  );
  tn.schedulePush(id);
  res.json(stock.getProduct(id));
});

router.delete('/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = stock.getProduct(id);
  const used = db.one('SELECT 1 FROM sale_items WHERE product_id = ?', id);
  if (used || p.tn_product_id) {
    db.run(`UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ?`, id);
    tn.schedulePush(id); // se despublica en la web
    return res.json({ deactivated: true });
  }
  db.run('DELETE FROM products WHERE id = ?', id);
  res.json({ deleted: true });
});

// Ajuste de stock: mode "add" (entrada), "remove" (salida/rotura) o "set" (conteo físico).
router.post('/products/:id/adjust', (req, res) => {
  const { mode, quantity, reason } = req.body || {};
  const qty = int(quantity, 'cantidad');
  const why = requireText(reason, 'el motivo del ajuste');
  const opts = { type: 'adjustment', reason: why, userId: uid(req) };
  if (mode === 'set') opts.setTo = qty;
  else if (mode === 'add' || mode === 'remove') {
    if (qty <= 0) throw badRequest('La cantidad debe ser mayor a cero');
    opts.delta = mode === 'add' ? qty : -qty;
  } else throw badRequest('Tipo de ajuste inválido');
  res.json(stock.change(Number(req.params.id), opts));
});

router.get('/stock-movements', (req, res) => {
  res.json(stock.movements({ productId: req.query.productId ? Number(req.query.productId) : null, limit: Math.min(1000, Number(req.query.limit) || 200) }));
});

router.post('/products/:id/sync', async (req, res) => {
  await tn.pushProduct(Number(req.params.id));
  res.json(stock.getProduct(Number(req.params.id)));
});

// ---------- Caja ----------

router.get('/cash', (req, res) => {
  const session = cash.currentSession();
  res.json({
    methods: cash.METHODS,
    session: session ? cash.summary(session.id) : null,
    movements: session ? cash.movements(session.id) : [],
    sales: session ? cash.listSales({ sessionId: session.id }) : [],
    unassigned: cash.movements(null).slice(0, 50),
    pendingSales: cash.listSales({ status: 'pending', limit: 50 }),
  });
});

router.post('/cash/open', (req, res) => res.status(201).json(cash.openSession({ openingAmount: req.body.openingAmount, notes: req.body.notes }, uid(req))));

router.post('/cash/close', (req, res) => res.json(cash.closeSession({ countedAmount: req.body.countedAmount, notes: req.body.notes }, uid(req))));

router.post('/cash/movements', (req, res) => res.status(201).json({ id: cash.manualMovement(req.body || {}, uid(req)) }));

router.get('/cash/sessions', (req, res) => res.json(cash.sessions()));

router.get('/cash/sessions/:id', (req, res) => {
  const id = Number(req.params.id);
  res.json({ ...cash.summary(id), movements: cash.movements(id), sales: cash.listSales({ sessionId: id }) });
});

router.get('/sales', (req, res) => res.json(cash.listSales({ status: req.query.status, limit: 300 })));

router.get('/sales/:id', (req, res) => res.json(cash.getSale(Number(req.params.id))));

router.post('/sales', async (req, res) => {
  const sale = cash.createSale(req.body || {}, uid(req));
  if (req.body.method !== 'mp_link') return res.status(201).json({ sale });
  try {
    const pref = await payments.saleCheckout(sale.id);
    res.status(201).json({ sale: cash.getSale(sale.id), init_point: pref.init_point, qr: await QRCode.toDataURL(pref.init_point, { margin: 1, width: 260 }) });
  } catch (err) {
    cash.cancelSale(sale.id, uid(req));
    throw err;
  }
});

router.post('/sales/:id/link', async (req, res) => {
  const pref = await payments.saleCheckout(Number(req.params.id));
  res.json({ init_point: pref.init_point, qr: await QRCode.toDataURL(pref.init_point, { margin: 1, width: 260 }) });
});

// Para cobros con link/QR cuando no hay webhook (ej. probando en local): verifica pagos por ID.
router.post('/payments/check', async (req, res) => {
  const paymentId = String((req.body && req.body.paymentId) || '').replace(/\D/g, '');
  if (!paymentId) throw badRequest('Ingresá el número de operación de Mercado Pago');
  res.json(await payments.processPayment(paymentId));
});

// Marca una venta pendiente como cobrada por otro medio.
router.post('/sales/:id/pay', (req, res) => {
  const method = String((req.body && req.body.method) || '');
  if (!cash.METHODS[method]) throw badRequest('Medio de pago inválido');
  const sale = db.tx(() => {
    const s = cash.getSale(Number(req.params.id));
    if (s.status !== 'pending') throw conflict('La venta no está pendiente');
    db.run('UPDATE sales SET payment_method = ? WHERE id = ?', method, s.id);
    return cash.finalizeSale(s.id, { userId: uid(req) });
  });
  res.json(sale);
});

router.post('/sales/:id/cancel', (req, res) => res.json(cash.cancelSale(Number(req.params.id), uid(req))));

// ---------- Configuración ----------

router.get('/settings', (req, res) => res.json(settings.publicView()));

router.put('/settings', (req, res) => {
  const values = { ...(req.body || {}) };
  for (const key of settings.SECRET_KEYS) {
    // Los secretos se muestran enmascarados: si vuelve la máscara, no se cambia.
    if (typeof values[key] === 'string' && values[key].includes('••••')) delete values[key];
  }
  for (const key of ['slot_interval_min', 'capacity', 'booking_window_days', 'min_advance_min', 'booking_hold_min']) {
    if (key in values && !(Number.isInteger(Number(values[key])) && Number(values[key]) >= 0)) throw badRequest(`Valor inválido para ${key}`);
  }
  if (values.public_url) values.public_url = String(values.public_url).trim().replace(/\/+$/, '');
  settings.set(values);
  res.json(settings.publicView());
});

router.get('/integrations', (req, res) => {
  res.json({
    publicUrl: settings.publicUrl(),
    mercadopago: { configured: mp.isConfigured(), log: recent('mercadopago', 30) },
    whatsapp: { configured: whatsapp.isConfigured(), enabled: whatsapp.isEnabled(), fields: whatsapp.FIELD_NAMES, log: recent('whatsapp', 30) },
    tiendanube: {
      configured: tn.isConfigured(),
      storeId: settings.get('tn_store_id'),
      queue: tn.pendingQueue(),
      linked: db.one('SELECT COUNT(*) AS n FROM products WHERE tn_product_id IS NOT NULL').n,
      errors: db.all(`SELECT id, name, tn_sync_error FROM products WHERE tn_sync_status = 'error' LIMIT 50`),
      log: recent('tiendanube', 30),
    },
  });
});

router.post('/integrations/mercadopago/test', async (req, res) => {
  const me = await mp.me();
  res.json({ ok: true, account: me.nickname || me.email || me.id, test: String(settings.get('mp_access_token')).startsWith('TEST-') });
});

router.post('/integrations/mercadopago/check-now', async (req, res) => res.json(await payments.reconcilePending({ force: true })));

router.post('/integrations/whatsapp/test', async (req, res) => res.json(await whatsapp.sendTest(req.body && req.body.phone)));

router.post('/integrations/tiendanube/test', async (req, res) => res.json({ ok: true, store: await tn.testConnection() }));

router.get('/integrations/tiendanube/install-url', (req, res) => res.json({ url: tn.installUrl() }));

router.post('/integrations/tiendanube/import', async (req, res) => {
  res.json(await tn.importProducts({ stockFrom: req.body && req.body.stockFrom === 'local' ? 'local' : 'remote' }));
});

router.post('/integrations/tiendanube/push-all', async (req, res) => res.json(await tn.pushAll()));

router.post('/integrations/tiendanube/webhooks', async (req, res) => res.json(await tn.registerWebhooks()));

router.post('/integrations/tiendanube/disconnect', (req, res) => {
  settings.set({ tn_access_token: '', tn_store_id: '' });
  res.json({ ok: true });
});

// ---------- Usuarios ----------

router.get('/users', (req, res) => res.json(db.all('SELECT id, username, name, created_at FROM users ORDER BY username')));

router.post('/users', (req, res) => {
  const username = requireText(req.body.username, 'el usuario');
  const password = String(req.body.password || '');
  if (password.length < 6) throw badRequest('La contraseña debe tener al menos 6 caracteres');
  if (db.one('SELECT 1 FROM users WHERE username = ?', username)) throw conflict('Ese usuario ya existe');
  auth.createUser(username, password, String(req.body.name || '').trim() || null);
  res.status(201).json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === uid(req)) throw badRequest('No podés borrar tu propio usuario');
  if (db.one('SELECT COUNT(*) AS n FROM users').n <= 1) throw badRequest('Tiene que quedar al menos un usuario');
  db.run('DELETE FROM users WHERE id = ?', id);
  res.json({ ok: true });
});

router.post('/me/password', (req, res) => {
  const { current, password } = req.body || {};
  const user = db.one('SELECT * FROM users WHERE id = ?', uid(req));
  if (!auth.verifyPassword(String(current || ''), user.password_hash)) throw badRequest('La contraseña actual no es correcta');
  if (String(password || '').length < 6) throw badRequest('La nueva contraseña debe tener al menos 6 caracteres');
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(password), user.id);
  res.json({ ok: true });
});

module.exports = router;
