process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'secreto123';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap } = require('../src/server');
const auth = require('../src/auth');
const db = require('../src/db');
const settings = require('../src/settings');
const { nowInTz, addDays } = require('../src/util');

let server;
let base;
let cookie;

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

before(async () => {
  const app = bootstrap({ dbFile: ':memory:' });
  auth.ensureAdmin();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'secreto123' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
  await call('/api/admin/hours', { method: 'PUT', body: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '00:00', end_time: '23:30' })) });
});

after(() => server.close());

test('resultados: ingresos, costos, gastos y ganancia con detalle de servicios y productos', async () => {
  const today = nowInTz(settings.get('timezone')).date;

  // Servicio con costo de insumos y un artículo con costo.
  const svc = (await call('/api/admin/services')).data[0];
  await call(`/api/admin/services/${svc.id}`, { method: 'PUT', body: { ...svc, price: 25000, deposit_amount: 8000, cost: 3000 } });
  const cat = (await call('/api/admin/categories', { method: 'POST', body: { name: 'Cremas' } })).data;
  const art = (
    await call('/api/admin/articles', {
      method: 'POST',
      body: { name: 'Crema', categoryId: cat.id, publishOnline: false, images: [{ data: PHOTO }], variants: [{ sku: 'CR', price: 10000, cost: 4000, stock: 10 }] },
    })
  ).data;
  const crema = art.variants[0];
  assert.equal(crema.cost, 4000);

  // Turno de hoy: seña en efectivo y después saldo + 2 cremas con $1.000 de descuento.
  await call('/api/admin/cash/open', { method: 'POST', body: { openingAmount: 0 } });
  const appt = (await call('/api/admin/appointments', { method: 'POST', body: { serviceId: svc.id, date: today, time: '00:00', name: 'Ana', phone: '1155550001', force: true } })).data;
  await call(`/api/admin/appointments/${appt.id}/deposit`, { method: 'POST', body: { amount: 8000, method: 'efectivo' } });
  const sale = await call('/api/admin/sales', {
    method: 'POST',
    body: { items: [{ appointmentId: appt.id }, { productId: crema.id, quantity: 2 }], discount: 1000, method: 'efectivo' },
  });
  assert.equal(sale.data.sale.total, 36000);
  // Servicio vendido en caja sin turno previo.
  await call('/api/admin/sales', { method: 'POST', body: { items: [{ serviceId: svc.id }], method: 'debito' } });

  // Gastos: alquiler por transferencia y un egreso de caja con categoría.
  const rent = await call('/api/admin/expenses', { method: 'POST', body: { date: today, category: 'Alquiler', amount: 50000, description: 'Octubre' } });
  assert.equal(rent.status, 201);
  await call('/api/admin/cash/movements', { method: 'POST', body: { type: 'expense', method: 'efectivo', amount: 2000, description: 'Guantes', category: 'Insumos y descartables' } });
  assert.equal((await call('/api/admin/expenses', { method: 'POST', body: { date: today, category: 'Inventada', amount: 1 } })).status, 400);
  // Un retiro del dueño sale de la caja pero no es gasto.
  await call('/api/admin/cash/movements', { method: 'POST', body: { type: 'expense', method: 'efectivo', amount: 5000, description: 'Retiro', category: 'retiro' } });

  // Venta web pagada: 1 crema, con envío (el envío no es ingreso).
  require('../src/services/weborders').processOrder(
    {
      id: 1, number: 1, status: 'open', payment_status: 'paid', created_at: new Date().toISOString(), paid_at: new Date().toISOString(),
      contact_name: 'Web', total: '13000', subtotal: '10000', discount: '0', shipping_cost_customer: '3000',
      products: [{ product_id: 1, variant_id: 1, sku: 'CR', name: 'Crema', price: '10000', quantity: 1 }],
    },
    { source: 'webhook' }
  );

  // Cambiar costos después no altera lo ya vendido.
  await call(`/api/admin/services/${svc.id}`, { method: 'PUT', body: { ...svc, price: 25000, deposit_amount: 8000, cost: 99999 } });
  db.run('UPDATE products SET cost = 99999 WHERE id = ?', crema.id);

  const r = (await call(`/api/admin/reports/results?from=${today}&to=${today}`)).data;
  assert.deepEqual(r.totals, { revenue: 79000, cost: 18000, gross: 61000, expenses: 52000, net: 9000, grossMargin: 77.2, netMargin: 11.4 });

  const services = r.channels.find((c) => c.key === 'services');
  assert.equal(services.revenue, 49540.54);
  assert.equal(services.cost, 6000);
  assert.equal(services.units, 2);
  assert.equal(r.services[0].units, 2);

  const crem = r.products.find((p) => p.name === 'Crema');
  assert.equal(crem.units, 3);
  assert.equal(crem.localUnits, 2);
  assert.equal(crem.webUnits, 1);
  assert.equal(crem.revenue, 29459.46);
  assert.equal(crem.cost, 12000);
  assert.equal(crem.missingCost, false);
  assert.equal(r.channels.find((c) => c.key === 'web_products').revenue, 10000);

  assert.deepEqual(r.expensesByCategory, [{ category: 'Alquiler', amount: 50000 }, { category: 'Insumos y descartables', amount: 2000 }]);
  assert.equal(r.extra.appointmentsAttended, 1);
  assert.equal(r.extra.shippingCharged, 3000);
  assert.equal(r.extra.salesCount, 3);
  assert.equal(r.series.length, 1);
  assert.equal(r.series[0].net, 9000);

  // El período anterior (ayer) está vacío.
  assert.equal(r.previous.revenue, 0);
  assert.equal(r.previous.to, addDays(today, -1));

  // Borrar el gasto de caja (caja abierta) también quita el egreso.
  const list = (await call(`/api/admin/expenses?from=${today}&to=${today}`)).data.expenses;
  const cashExp = list.find((e) => e.cash_movement_id);
  assert.equal((await call(`/api/admin/expenses/${cashExp.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM cash_movements WHERE id = ?', cashExp.cash_movement_id).n, 0);
  assert.equal((await call(`/api/admin/reports/results?from=${today}&to=${today}`)).data.totals.expenses, 50000);
});

test('resultados: avisa los productos y servicios sin costo cargado', async () => {
  const today = nowInTz(settings.get('timezone')).date;
  const svc2 = (await call('/api/admin/services', { method: 'POST', body: { name: 'Sin costo', duration_min: 30, price: 1000 } })).data;
  await call('/api/admin/sales', { method: 'POST', body: { items: [{ serviceId: svc2.id }], method: 'efectivo' } });
  const r = (await call(`/api/admin/reports/results?from=${today}&to=${today}`)).data;
  assert.equal(r.extra.servicesWithoutCost, 1);
  assert.equal(r.services.find((s) => s.name === 'Sin costo').missingCost, true);
});
