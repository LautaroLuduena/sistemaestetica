process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'secreto123';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { bootstrap } = require('../src/server');
const auth = require('../src/auth');
const db = require('../src/db');
const http = require('../src/services/http');
const settings = require('../src/settings');
const { addDays, nowInTz } = require('../src/util');

let server;
let base;
let cookie;

// ---- Simulación de las APIs de Mercado Pago y Tienda Nube ----
const remote = { payments: {}, preferences: [], tnCalls: [], orders: {}, products: [], waMessages: [], waFail: null, orderList: [] };

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const realFetch = http.fetch;
http.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.host === 'api.mercadopago.com') {
    if (u.pathname === '/checkout/preferences') {
      const body = JSON.parse(opts.body);
      remote.preferences.push(body);
      return reply(201, { id: `pref-${remote.preferences.length}`, init_point: `https://mp.test/checkout/${remote.preferences.length}` });
    }
    if (u.pathname === '/v1/payments/search') {
      const ref = u.searchParams.get('external_reference');
      return reply(200, { results: Object.values(remote.payments).filter((p) => p.external_reference === ref) });
    }
    const m = u.pathname.match(/^\/v1\/payments\/(\d+)$/);
    if (m) return remote.payments[m[1]] ? reply(200, remote.payments[m[1]]) : reply(404, { message: 'not found' });
    const r = u.pathname.match(/^\/v1\/payments\/(\d+)\/refunds$/);
    if (r) return reply(201, { id: 1, payment_id: r[1] });
  }
  if (u.host === 'graph.facebook.com') {
    const body = JSON.parse(opts.body);
    remote.waMessages.push(body);
    if (remote.waFail) return reply(400, { error: { message: remote.waFail } });
    return reply(200, { messages: [{ id: `wamid.${remote.waMessages.length}` }] });
  }
  if (u.host === 'api.tiendanube.com') {
    const path = u.pathname.replace(/^\/v1\/\d+/, '');
    remote.tnCalls.push({ method: opts.method || 'GET', path, body: opts.body ? JSON.parse(opts.body) : null });
    const order = path.match(/^\/orders\/(\d+)$/);
    if (order) return reply(200, remote.orders[order[1]]);
    if (path === '/orders') return reply(200, u.searchParams.get('page') === '1' ? remote.orderList : []);
    if (path === '/products' && opts.method === 'POST') return reply(201, { id: 900, variants: [{ id: 901 }] });
    if (path === '/products' && (opts.method || 'GET') === 'GET') return reply(200, u.searchParams.get('page') === '1' ? remote.products : []);
    return reply(200, {});
  }
  return realFetch(url, opts);
};

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', cookie, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

const waitQueue = () => new Promise((r) => setTimeout(r, 600));

// Un día abierto dentro de la ventana de reservas.
const day = () => addDays(nowInTz(settings.get('timezone')).date, 3);

before(async () => {
  const app = bootstrap({ dbFile: ':memory:' });
  auth.ensureAdmin();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secreto123' }),
  });
  cookie = res.headers.get('set-cookie').split(';')[0];
  // Abierto todos los días de 10 a 12 para que los tests no dependan del día de la semana.
  await call('/api/admin/hours', { method: 'PUT', body: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '10:00', end_time: '12:00' })) });
  settings.set({ mp_access_token: 'TEST-123', public_url: 'https://estetica.test', tn_store_id: '555', tn_access_token: 'tn-token' });
});

after(() => server.close());

beforeEach(() => {
  remote.tnCalls.length = 0;
});

test('rutas del panel requieren sesión', async () => {
  const res = await fetch(`${base}/api/admin/dashboard`);
  assert.equal(res.status, 401);
});

test('horarios disponibles respetan duración y capacidad', async () => {
  const { data } = await call(`/api/public/slots?serviceId=1&date=${day()}`);
  // servicio de 30 min, franjas cada 30 min entre 10 y 12
  assert.deepEqual(data.slots, ['10:00', '10:30', '11:00', '11:30']);
  const long = await call(`/api/public/slots?serviceId=2&date=${day()}`);
  assert.deepEqual(long.data.slots, ['10:00', '10:30', '11:00']);
});

test('reserva web: queda pendiente, genera seña y se confirma con el webhook de Mercado Pago', async () => {
  const res = await call('/api/public/bookings', {
    method: 'POST',
    body: { serviceId: 1, date: day(), time: '10:00', name: 'Ana Pérez', phone: '11 2345-6789', email: 'ana@test.com' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.booking.status, 'pending_payment');
  assert.ok(res.data.init_point.startsWith('https://mp.test/checkout/'));
  const pref = remote.preferences.at(-1);
  assert.equal(pref.items[0].unit_price, 8000);
  assert.equal(pref.binary_mode, true);
  assert.equal(pref.notification_url, 'https://estetica.test/api/webhooks/mercadopago?source_news=webhooks');
  const apptId = Number(pref.external_reference.split(':')[1]);

  // El horario queda bloqueado mientras se espera el pago.
  const slots = await call(`/api/public/slots?serviceId=1&date=${day()}`);
  assert.ok(!slots.data.slots.includes('10:00'));
  const dup = await call('/api/public/bookings', { method: 'POST', body: { serviceId: 1, date: day(), time: '10:00', name: 'Otra', phone: '1199998888' } });
  assert.equal(dup.status, 409);

  remote.payments['111'] = { id: 111, status: 'approved', external_reference: `appt:${apptId}`, transaction_amount: 8000 };
  const hook = await call('/api/webhooks/mercadopago?data.id=111&type=payment', { method: 'POST', body: { type: 'payment', data: { id: '111' } } });
  assert.equal(hook.status, 200);
  // Notificación repetida: no se duplica la seña.
  await call('/api/webhooks/mercadopago?data.id=111&type=payment', { method: 'POST', body: { type: 'payment', data: { id: '111' } } });

  const appt = (await call(`/api/admin/appointments/${apptId}`)).data;
  assert.equal(appt.status, 'confirmed');
  assert.equal(appt.deposit_paid, 8000);
  assert.equal(appt.balance, 17000);
  assert.equal(appt.movements.length, 1);
  assert.equal(appt.movements[0].payment_method, 'mercadopago');
});

test('seña acreditada después de vencer con el horario ocupado queda marcada para revisar', async () => {
  const res = await call('/api/public/bookings', { method: 'POST', body: { serviceId: 1, date: day(), time: '11:30', name: 'Bea', phone: '1155550000' } });
  const apptId = Number(remote.preferences.at(-1).external_reference.split(':')[1]);
  // vence la reserva y otra persona toma el horario
  db.run(`UPDATE appointments SET expires_at = datetime('now', '-1 minute') WHERE id = ?`, apptId);
  const other = await call('/api/admin/appointments', { method: 'POST', body: { serviceId: 1, date: day(), time: '11:30', name: 'Carla', phone: '1144440000' } });
  assert.equal(other.status, 201, JSON.stringify(other.data));

  remote.payments['222'] = { id: 222, status: 'approved', external_reference: `appt:${apptId}`, transaction_amount: 8000 };
  const check = await call(`/api/public/bookings/${res.data.booking.token}/check`, { method: 'POST', body: { paymentId: '222' } });
  assert.equal(check.data.booking.status, 'expired');
  assert.ok(check.data.booking.alert);
  const appt = (await call(`/api/admin/appointments/${apptId}`)).data;
  assert.equal(appt.deposit_paid, 8000);
  assert.match(appt.alert, /reprogramar o devolver/);
});

test('firma de webhook de Mercado Pago inválida es rechazada', async () => {
  settings.set({ mp_webhook_secret: 'clave' });
  try {
    const bad = await call('/api/webhooks/mercadopago?data.id=111&type=payment', {
      method: 'POST',
      body: { type: 'payment', data: { id: '111' } },
      headers: { 'x-signature': 'ts=1,v1=abc', 'x-request-id': 'r1' },
    });
    assert.equal(bad.status, 401);
    const ts = '1700000000';
    const v1 = crypto.createHmac('sha256', 'clave').update(`id:111;request-id:r1;ts:${ts};`).digest('hex');
    const ok = await call('/api/webhooks/mercadopago?data.id=111&type=payment', {
      method: 'POST',
      body: { type: 'payment', data: { id: '111' } },
      headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'r1' },
    });
    assert.equal(ok.status, 200);
  } finally {
    settings.set({ mp_webhook_secret: '' });
  }
});

test('stock: alta, ajustes y sincronización con Tienda Nube', async () => {
  const created = await call('/api/admin/products', { method: 'POST', body: { name: 'Crema post bronceado', sku: 'CR-1', price: 9000, stock: 10, min_stock: 2 } });
  assert.equal(created.status, 201);
  assert.equal(created.data.stock, 10);
  await waitQueue();
  const post = remote.tnCalls.find((c) => c.method === 'POST' && c.path === '/products');
  assert.ok(post, 'se crea el producto en Tienda Nube');
  assert.equal(post.body.variants[0].stock, 10);
  assert.equal(post.body.variants[0].sku, 'CR-1');

  remote.tnCalls.length = 0;
  const adj = await call(`/api/admin/products/${created.data.id}/adjust`, { method: 'POST', body: { mode: 'remove', quantity: 3, reason: 'Rotura' } });
  assert.equal(adj.data.stock, 7);
  const set = await call(`/api/admin/products/${created.data.id}/adjust`, { method: 'POST', body: { mode: 'set', quantity: 12, reason: 'Conteo' } });
  assert.equal(set.data.stock, 12);
  await waitQueue();
  const puts = remote.tnCalls.filter((c) => c.method === 'PUT' && c.path === '/products/900/variants/901');
  assert.ok(puts.length >= 1);
  assert.equal(puts.at(-1).body.stock, 12);

  const noReason = await call(`/api/admin/products/${created.data.id}/adjust`, { method: 'POST', body: { mode: 'add', quantity: 1 } });
  assert.equal(noReason.status, 400);
  const mv = (await call(`/api/admin/stock-movements?productId=${created.data.id}`)).data;
  assert.deepEqual(mv.map((m) => m.quantity), [5, -3, 10]);
});

test('Tienda Nube: una orden descuenta stock local sin reenviarlo, y la cancelación lo repone', async () => {
  const p = db.one(`SELECT * FROM products WHERE sku = 'CR-1'`);
  remote.orders['7001'] = { id: 7001, number: 150, products: [{ product_id: 900, variant_id: 901, quantity: 2, sku: 'CR-1', name: 'Crema' }] };
  remote.tnCalls.length = 0;

  const created = await call('/api/webhooks/tiendanube', { method: 'POST', body: { store_id: 555, event: 'order/created', id: 7001 } });
  assert.equal(created.status, 200);
  await call('/api/webhooks/tiendanube', { method: 'POST', body: { store_id: 555, event: 'order/created', id: 7001 } }); // duplicado
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', p.id).stock, p.stock - 2);
  await waitQueue();
  assert.ok(!remote.tnCalls.some((c) => c.method === 'PUT'), 'no se reenvía el stock a Tienda Nube');

  await call('/api/webhooks/tiendanube', { method: 'POST', body: { store_id: 555, event: 'order/cancelled', id: 7001 } });
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', p.id).stock, p.stock);

  // otra tienda: se ignora
  remote.orders['7002'] = { id: 7002, products: [{ product_id: 900, variant_id: 901, quantity: 5 }] };
  await call('/api/webhooks/tiendanube', { method: 'POST', body: { store_id: 999, event: 'order/created', id: 7002 } });
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', p.id).stock, p.stock);
});

test('Tienda Nube: webhook con HMAC inválido es rechazado cuando hay client secret', async () => {
  settings.set({ tn_client_secret: 'sec' });
  try {
    const bad = await call('/api/webhooks/tiendanube', { method: 'POST', body: { store_id: 555, event: 'order/created', id: 1 }, headers: { 'x-linkedstore-hmac-sha256': 'nope' } });
    assert.equal(bad.status, 401);
    const raw = JSON.stringify({ store_id: 555, event: 'app/uninstalled', id: 1 });
    const sig = crypto.createHmac('sha256', 'sec').update(raw).digest('hex');
    const ok = await call('/api/webhooks/tiendanube', { method: 'POST', body: raw, headers: { 'x-linkedstore-hmac-sha256': sig } });
    assert.equal(ok.status, 200);
  } finally {
    settings.set({ tn_client_secret: '' });
  }
});

test('Tienda Nube: importar productos vincula por SKU y crea los nuevos', async () => {
  remote.products = [
    { id: 900, name: { es: 'Crema post bronceado' }, variants: [{ id: 901, sku: 'CR-1', price: '9000.00', stock: 4, values: [] }] },
    { id: 950, name: { es: 'Aceite' }, description: { es: '<p>Bronceador</p>' }, variants: [{ id: 951, sku: 'AC-1', price: '5000.00', stock: 6, values: [{ es: '100ml' }] }] },
  ];
  const r = await call('/api/admin/integrations/tiendanube/import', { method: 'POST', body: { stockFrom: 'remote' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created, 1);
  const aceite = db.one(`SELECT * FROM products WHERE sku = 'AC-1'`);
  assert.equal(aceite.name, 'Aceite - 100ml');
  assert.equal(aceite.stock, 6);
  assert.equal(aceite.description, 'Bronceador');
  assert.equal(db.one(`SELECT stock FROM products WHERE sku = 'CR-1'`).stock, 4);
});

test('caja: no se puede vender con la caja cerrada; venta, saldo de turno, anulación y cierre', async () => {
  const closed = await call('/api/admin/sales', { method: 'POST', body: { items: [{ description: 'x', unitPrice: 10 }], method: 'efectivo' } });
  assert.equal(closed.status, 409);

  const open = await call('/api/admin/cash/open', { method: 'POST', body: { openingAmount: 5000 } });
  assert.equal(open.status, 201);

  const cr = db.one(`SELECT * FROM products WHERE sku = 'CR-1'`);
  const appt = db.one(`SELECT id FROM appointments WHERE status = 'confirmed' AND deposit_paid > 0 ORDER BY id LIMIT 1`);

  const sale = await call('/api/admin/sales', {
    method: 'POST',
    body: { items: [{ productId: cr.id, quantity: 2 }, { appointmentId: appt.id }], method: 'efectivo', discount: 1000 },
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  // 2 x 9000 + saldo 17000 - 1000
  assert.equal(sale.data.sale.total, 34000);
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', cr.id).stock, cr.stock - 2);
  const a = (await call(`/api/admin/appointments/${appt.id}`)).data;
  assert.equal(a.status, 'completed');
  assert.equal(a.balance, 0);

  const tooMany = await call('/api/admin/sales', { method: 'POST', body: { items: [{ productId: cr.id, quantity: 999 }], method: 'debito' } });
  assert.equal(tooMany.status, 409);

  const card = await call('/api/admin/sales', { method: 'POST', body: { items: [{ productId: cr.id, quantity: 1 }], method: 'debito' } });
  const cancel = await call(`/api/admin/sales/${card.data.sale.id}/cancel`, { method: 'POST' });
  assert.equal(cancel.data.status, 'cancelled');
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', cr.id).stock, cr.stock - 2);

  await call('/api/admin/cash/movements', { method: 'POST', body: { type: 'expense', method: 'efectivo', amount: 2000, description: 'Limpieza' } });

  const state = (await call('/api/admin/cash')).data;
  assert.equal(state.session.expectedCash, 5000 + 34000 - 2000);
  assert.equal(state.session.byMethod.debito, 0);

  const close = await call('/api/admin/cash/close', { method: 'POST', body: { countedAmount: 36500 } });
  assert.equal(close.data.session.difference, -500);
  assert.equal((await call('/api/admin/cash')).data.session, null);
});

test('caja: cobro con link de Mercado Pago queda pendiente y se completa con el pago', async () => {
  await call('/api/admin/cash/open', { method: 'POST', body: { openingAmount: 0 } });
  const cr = db.one(`SELECT * FROM products WHERE sku = 'CR-1'`);
  const res = await call('/api/admin/sales', { method: 'POST', body: { items: [{ productId: cr.id, quantity: 1 }], method: 'mp_link' } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.sale.status, 'pending');
  assert.ok(res.data.qr.startsWith('data:image/png'));
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', cr.id).stock, cr.stock, 'no descuenta hasta cobrar');

  remote.payments['333'] = { id: 333, status: 'approved', external_reference: `sale:${res.data.sale.id}`, transaction_amount: 9000 };
  await call('/api/webhooks/mercadopago', { method: 'POST', body: { type: 'payment', data: { id: '333' } } });
  const sale = (await call(`/api/admin/sales/${res.data.sale.id}`)).data;
  assert.equal(sale.status, 'paid');
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', cr.id).stock, cr.stock - 1);
  assert.equal((await call('/api/admin/cash')).data.session.byMethod.mercadopago, 9000);
});

test('cancelar turno devolviendo la seña por Mercado Pago', async () => {
  const res = await call('/api/public/bookings', { method: 'POST', body: { serviceId: 1, date: addDays(day(), 1), time: '10:00', name: 'Dana', phone: '1133332222' } });
  const apptId = Number(remote.preferences.at(-1).external_reference.split(':')[1]);
  remote.payments['444'] = { id: 444, status: 'approved', external_reference: `appt:${apptId}`, transaction_amount: 8000 };
  await call(`/api/public/bookings/${res.data.booking.token}/check`, { method: 'POST', body: { paymentId: '444' } });
  const cancel = await call(`/api/admin/appointments/${apptId}/cancel`, { method: 'POST', body: { refund: true } });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  assert.equal(cancel.data.status, 'cancelled');
  assert.equal(cancel.data.deposit_paid, 0);
  const again = await call(`/api/admin/appointments/${apptId}/cancel`, { method: 'POST', body: { refund: true } });
  assert.equal(again.status, 409);
});

test('WhatsApp: normaliza teléfonos argentinos', () => {
  const { toWhatsAppNumber } = require('../src/services/whatsapp');
  assert.equal(toWhatsAppNumber('11 2345-6789'), '5491123456789');
  assert.equal(toWhatsAppNumber('011 15 2345-6789'), '5491123456789');
  assert.equal(toWhatsAppNumber('+54 9 11 2345 6789'), '5491123456789');
  assert.equal(toWhatsAppNumber('351 15 555 1234'), '5493515551234');
  assert.equal(toWhatsAppNumber('0351 4555123'), '5493514555123');
  assert.equal(toWhatsAppNumber('1234'), null);
});

test('verificación automática: encuentra la seña pagada sin webhook y envía la confirmación por WhatsApp', async () => {
  settings.set({ wa_enabled: '1', wa_token: 'wa-token', wa_phone_number_id: '777', wa_template_name: 'confirmacion_turno', wa_info: 'Venir sin cremas.\nRopa oscura.' });
  remote.waMessages.length = 0;
  const date = addDays(day(), 2);
  const res = await call('/api/public/bookings', { method: 'POST', body: { serviceId: 1, date, time: '11:00', name: 'Eva Gómez', phone: '011 15 4444-5555' } });
  const apptId = Number(remote.preferences.at(-1).external_reference.split(':')[1]);
  assert.equal(res.data.booking.status, 'pending_payment');

  // Todavía sin pagos: no cambia nada.
  const payments = require('../src/services/payments');
  let r = await payments.reconcilePending();
  assert.equal(r.approved, 0);

  // Llega un pago aprobado pero el webhook nunca se recibe.
  remote.payments['555'] = { id: 555, status: 'approved', external_reference: `appt:${apptId}`, transaction_amount: 8000 };
  db.run('UPDATE appointments SET mp_checked_at = NULL WHERE id = ?', apptId);
  r = await payments.reconcilePending();
  assert.equal(r.approved, 1);
  const appt = (await call(`/api/admin/appointments/${apptId}`)).data;
  assert.equal(appt.status, 'confirmed');
  assert.equal(appt.deposit_paid, 8000);

  await new Promise((done) => setTimeout(done, 100));
  assert.equal(remote.waMessages.length, 1);
  const msg = remote.waMessages[0];
  assert.equal(msg.to, '5491144445555');
  assert.equal(msg.template.name, 'confirmacion_turno');
  const [nombre, servicio, fecha, hora, info] = msg.template.components[0].parameters.map((p) => p.text);
  assert.deepEqual([nombre, servicio, hora, info], ['Eva', 'Bronceado orgánico (spray)', '11:00 hs', 'Venir sin cremas. · Ropa oscura.']);
  assert.match(fecha, /^[A-ZÁÉÍÓÚ][a-záéíóú]+, \d{1,2} de [a-z]+$/);
  assert.equal((await call(`/api/admin/appointments/${apptId}`)).data.wa_status, 'sent');

  // Otra pasada no duplica el pago ni el mensaje.
  db.run('UPDATE appointments SET mp_checked_at = NULL WHERE id = ?', apptId);
  await payments.reconcilePending();
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(remote.waMessages.length, 1);
  assert.equal((await call(`/api/admin/appointments/${apptId}`)).data.deposit_paid, 8000);
});

test('WhatsApp: el error de envío queda registrado en el turno y se puede reintentar', async () => {
  const created = await call('/api/admin/appointments', { method: 'POST', body: { serviceId: 1, date: addDays(day(), 3), time: '10:00', name: 'Flor', phone: '1166667777' } });
  const id = created.data.id;
  remote.waFail = 'Template name does not exist';
  // Cobrar la seña en el local también dispara la confirmación (acá falla por la plantilla).
  await call('/api/admin/cash/open', { method: 'POST', body: { openingAmount: 0 } });
  await call(`/api/admin/appointments/${id}/deposit`, { method: 'POST', body: { method: 'efectivo', amount: 8000 } });
  await new Promise((done) => setTimeout(done, 100));
  assert.equal((await call(`/api/admin/appointments/${id}`)).data.wa_status, 'error');
  const manual = await call(`/api/admin/appointments/${id}/whatsapp`, { method: 'POST' });
  assert.equal(manual.status, 502);
  let appt = (await call(`/api/admin/appointments/${id}`)).data;
  assert.equal(appt.wa_status, 'error');
  assert.match(appt.wa_error, /Template name/);
  assert.ok(appt.wa_link.startsWith('https://wa.me/5491166667777?text='));

  remote.waFail = null;
  const retry = await call(`/api/admin/appointments/${id}/whatsapp`, { method: 'POST' });
  assert.equal(retry.status, 200);
  appt = (await call(`/api/admin/appointments/${id}`)).data;
  assert.equal(appt.wa_status, 'sent');
});

function fullOrder(id, overrides = {}) {
  return {
    id,
    number: 2000 + id,
    status: 'open',
    payment_status: 'paid',
    shipping_status: 'unpacked',
    created_at: new Date().toISOString().replace('Z', '+0000'),
    paid_at: new Date().toISOString().replace('Z', '+0000'),
    contact_name: 'Lucía Fernández',
    contact_email: 'lucia@test.com',
    contact_phone: '+54 9 11 5555 1234',
    contact_identification: '30123456',
    shipping_address: { name: 'Lucía Fernández', address: 'Av. Siempreviva', number: '742', floor: '3B', locality: 'Palermo', city: 'CABA', province: 'Capital Federal', zipcode: '1425', phone: '1155551234' },
    shipping_option: 'Correo Argentino - Envío a domicilio',
    shipping_pickup_type: 'ship',
    shipping_cost_customer: '3500.00',
    gateway: 'mercadopago',
    gateway_name: 'Mercado Pago',
    gateway_id: '9001',
    payment_details: { method: 'credit_card', credit_card_company: 'visa', installments: '3' },
    subtotal: '18000.00',
    discount: '0.00',
    discount_coupon: '1000.00',
    discount_gateway: '0.00',
    total: '20500.00',
    currency: 'ARS',
    note: 'Dejar en portería',
    products: [{ product_id: 900, variant_id: 901, sku: 'CR-1', name: 'Crema post bronceado', price: '9000.00', quantity: 2 }],
    ...overrides,
  };
}

test('Ventas web: una orden de Tienda Nube llega con cliente, envío, pago y productos', async () => {
  const cr = db.one(`SELECT * FROM products WHERE sku = 'CR-1'`);
  remote.orders['8001'] = fullOrder(8001);
  const hook = await call('/api/webhooks/tiendanube', { method: 'POST', body: { store_id: 555, event: 'order/created', id: 8001 } });
  assert.equal(hook.status, 200);
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', cr.id).stock, cr.stock - 2);

  // El evento de pago/actualización de la misma orden no vuelve a descontar.
  await call('/api/webhooks/tiendanube', { method: 'POST', body: { store_id: 555, event: 'order/paid', id: 8001 } });
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', cr.id).stock, cr.stock - 2);

  const list = (await call('/api/admin/web-orders')).data;
  const row = list.orders.find((o) => o.tn_order_id === '8001');
  assert.ok(row);
  assert.equal(list.stats.to_ship >= 1, true);
  assert.equal(row.seen_at, null);

  const o = (await call(`/api/admin/web-orders/${row.id}`)).data;
  assert.equal(o.number, '10001');
  assert.equal(o.customer_name, 'Lucía Fernández');
  assert.equal(o.customer_dni, '30123456');
  assert.equal(o.shipping_address, 'Av. Siempreviva 742, 3B - Palermo');
  assert.equal(o.shipping_zipcode, '1425');
  assert.equal(o.shipping_method, 'Correo Argentino - Envío a domicilio');
  assert.equal(o.shipping_cost, 3500);
  assert.equal(o.discount, 1000);
  assert.equal(o.total, 20500);
  assert.equal(o.gateway, 'Mercado Pago');
  assert.equal(o.payment_detail, 'Tarjeta de crédito · VISA · 3 cuotas');
  assert.equal(o.customer_note, 'Dejar en portería');
  assert.equal(o.stock_status, 'applied');
  assert.equal(o.items[0].product_id, cr.id);
  assert.equal(o.items[0].subtotal, 18000);
  assert.equal(o.raw, undefined);
  assert.ok(db.one(`SELECT 1 FROM clients WHERE email = 'lucia@test.com'`));
  assert.ok((await call(`/api/admin/web-orders/${row.id}`)).data.seen_at);

  // Corroborar el pago contra Mercado Pago.
  remote.payments['9001'] = { id: 9001, status: 'approved', transaction_amount: 20500, transaction_details: { net_received_amount: 19000 }, installments: 3, payment_method_id: 'visa' };
  const v = (await call(`/api/admin/web-orders/${row.id}/verify-payment`, { method: 'POST' })).data;
  assert.equal(v.verifiable, true);
  assert.equal(v.status, 'approved');
  assert.equal(v.matches_total, true);
  assert.equal(v.net_amount, 19000);

  // Cancelación: se repone el stock y queda registrado.
  remote.orders['8001'] = fullOrder(8001, { status: 'cancelled', cancelled_at: new Date().toISOString() });
  await call('/api/webhooks/tiendanube', { method: 'POST', body: { store_id: 555, event: 'order/cancelled', id: 8001 } });
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', cr.id).stock, cr.stock);
  const after = (await call(`/api/admin/web-orders/${row.id}`)).data;
  assert.equal(after.status, 'cancelled');
  assert.equal(after.stock_status, 'reverted');
});

test('Ventas web: la sincronización importa órdenes viejas sin tocar el stock y descuenta las nuevas', async () => {
  const cr = db.one(`SELECT * FROM products WHERE sku = 'CR-1'`);
  settings.set({ tn_orders_since: '', tn_orders_last_sync: '' });
  const weborders = require('../src/services/weborders');
  // Orden de hace 5 días (anterior a la conexión) y otra que se crea después.
  remote.orderList = [fullOrder(8002, { created_at: new Date(Date.now() - 5 * 86400e3).toISOString() })];
  let r = await weborders.sync();
  assert.equal(r.synced, 1);
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', cr.id).stock, cr.stock);
  assert.equal(db.one(`SELECT stock_status FROM web_orders WHERE tn_order_id = '8002'`).stock_status, 'not_applied');

  await new Promise((done) => setTimeout(done, 1100));
  remote.orderList = [fullOrder(8003, { created_at: new Date().toISOString(), products: [{ product_id: 900, variant_id: 901, sku: 'CR-1', name: 'Crema', price: '9000.00', quantity: 1 }] })];
  r = await weborders.sync();
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', cr.id).stock, cr.stock - 1);
  // Si la misma orden llega después por webhook, no se descuenta dos veces.
  remote.orders['8003'] = remote.orderList[0];
  await call('/api/webhooks/tiendanube', { method: 'POST', body: { store_id: 555, event: 'order/created', id: 8003 } });
  assert.equal(db.one('SELECT stock FROM products WHERE id = ?', cr.id).stock, cr.stock - 1);
});

test('reprogramar: solo se ofrecen horarios libres y el propio turno no se bloquea a sí mismo', async () => {
  const date = addDays(day(), 6);
  const a = (await call('/api/admin/appointments', { method: 'POST', body: { serviceId: 1, date, time: '10:00', name: 'Gina', phone: '1170000001' } })).data;
  await call('/api/admin/appointments', { method: 'POST', body: { serviceId: 1, date, time: '10:30', name: 'Hilda', phone: '1170000002' } });

  const slots = (await call(`/api/admin/availability?appointmentId=${a.id}&date=${date}`)).data.slots;
  assert.deepEqual(slots, ['10:00', '11:00', '11:30']);

  // Para un turno nuevo del mismo servicio, 10:00 y 10:30 están ocupados.
  const fresh = (await call(`/api/admin/availability?serviceId=1&date=${date}`)).data.slots;
  assert.deepEqual(fresh, ['11:00', '11:30']);

  const days = (await call(`/api/admin/availability?appointmentId=${a.id}`)).data.days;
  assert.equal(days.find((d) => d.date === date).free, 3);
  assert.ok(days.length > 30, 'el panel ve más días que la ventana pública');

  const overlap = await call(`/api/admin/appointments/${a.id}/reschedule`, { method: 'POST', body: { date, time: '10:30' } });
  assert.equal(overlap.status, 409);
  assert.match(overlap.data.error, /superpone/);
  const ok = await call(`/api/admin/appointments/${a.id}/reschedule`, { method: 'POST', body: { date, time: '11:30' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.start_time, '11:30');
  assert.equal(ok.data.end_time, '12:00');
});
