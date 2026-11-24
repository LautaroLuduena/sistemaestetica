process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'secreto123';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { bootstrap } = require('../src/server');
const auth = require('../src/auth');
const db = require('../src/db');

let server;
let base;
let cookie;

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

const asDataUrl = (buf) => `data:application/octet-stream;base64,${Buffer.from(buf).toString('base64')}`;
const importFile = (buf, filename, dryRun) => call('/api/admin/articles/import', { method: 'POST', body: { file: asDataUrl(buf), filename, dryRun } });

before(async () => {
  const app = bootstrap({ dbFile: ':memory:' });
  auth.ensureAdmin();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'secreto123' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(() => server.close());

test('importar la planilla modelo: vista previa sin guardar y luego importación real', async () => {
  const tpl = await call('/api/admin/articles/template');
  assert.equal(tpl.status, 200);

  const preview = (await importFile(tpl.data, 'modelo.xlsx', true)).data;
  assert.equal(preview.dryRun, true);
  assert.equal(preview.created, 2);
  assert.equal(preview.errors.length, 0);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM articles').n, 0, 'la vista previa no guarda nada');
  assert.equal(db.one('SELECT COUNT(*) AS n FROM categories').n, 0);

  const real = (await importFile(tpl.data, 'modelo.xlsx', false)).data;
  assert.equal(real.created, 2);
  assert.equal(real.variants, 3);
  const aceite = db.one(`SELECT * FROM articles WHERE name = 'Aceite bronceador'`);
  const a = (await call(`/api/admin/articles/${aceite.id}`)).data;
  assert.deepEqual(a.attributes, ['Tamaño']);
  assert.deepEqual(a.variants.map((v) => [v.values[0], v.price, v.promo_price, v.cost, v.stock]), [['100ml', 6000, null, 2500, 8], ['250ml', 11000, 9900, 4500, 5]]);
  assert.equal(a.category.name, 'Bronceado');
  const crema = (await call(`/api/admin/articles/${db.one(`SELECT id FROM articles WHERE name = 'Crema post solar'`).id}`)).data;
  assert.equal(crema.subcategory.name, 'Post solar');
  assert.equal(crema.images[0].src, 'https://ejemplo.com/foto-crema.jpg');
  assert.equal(crema.publish_online, 1);
});

test('exportar, editar en Excel y volver a importar actualiza precios y stock', async () => {
  const exp = await call('/api/admin/articles/export');
  assert.equal(exp.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(exp.data);
  const ws = wb.getWorksheet('Artículos');
  const headers = ws.getRow(1).values;
  const col = (h) => headers.indexOf(h);
  assert.equal(ws.rowCount, 4); // encabezado + 3 variantes

  ws.eachRow((row, n) => {
    if (n === 1) return;
    if (row.getCell(col('SKU')).value === 'AC-100') {
      row.getCell(col('Precio')).value = 6500;
      row.getCell(col('Stock')).value = 20;
      row.getCell(col('Precio promocional')).value = null; // vacío: no cambia
    }
    if (row.getCell(col('SKU')).value === 'AC-250') row.getCell(col('Precio promocional')).value = 0; // 0: quita la promo
  });
  // Variante nueva del mismo artículo.
  const src = ws.getRow(3).values;
  const added = ws.addRow(src.slice(1));
  added.getCell(col('SKU')).value = 'AC-500';
  added.getCell(col('Valor 1')).value = '500ml';
  added.getCell(col('Precio')).value = 18000;
  added.getCell(col('Stock')).value = 3;
  const buf = await wb.xlsx.writeBuffer();

  const res = (await importFile(buf, 'articulos.xlsx', false)).data;
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.equal(res.updated, 2);
  assert.equal(res.created, 0);
  const id = db.one(`SELECT id FROM articles WHERE name = 'Aceite bronceador'`).id;
  const a = (await call(`/api/admin/articles/${id}`)).data;
  assert.deepEqual(a.variants.map((v) => [v.sku, v.price, v.promo_price, v.stock]), [['AC-100', 6500, null, 20], ['AC-250', 11000, null, 5], ['AC-500', 18000, null, 3]]);
  const mv = db.one(`SELECT * FROM stock_movements m JOIN products p ON p.id = m.product_id WHERE p.sku = 'AC-100' ORDER BY m.id DESC LIMIT 1`);
  assert.equal(mv.reason, 'Importación de planilla');
  assert.equal(mv.quantity, 12);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM articles').n, 2, 'no se duplican artículos');
});

test('importar CSV con ";" y decimales con coma; las filas con error se informan y el resto se importa', async () => {
  const csv = [
    'Nombre;Categoría;Precio;Costo;Stock;Peso (kg);Alto (cm);Ancho (cm);Profundidad (cm)',
    'Exfoliante;Cuidado corporal;8.500,50;3200;7;0,2;10;6;6',
    'Sin precio;Cuidado corporal;;;3;;;;',
    'Gel aloe;;5000;;2;;;;',
    'Bruma;Cuidado corporal;abc;;1;;;;',
  ].join('\r\n');
  const res = (await importFile(Buffer.from(`﻿${csv}`, 'utf8'), 'articulos.csv', false)).data;
  assert.equal(res.created, 1);
  assert.deepEqual(
    res.errors.map((e) => [e.rows[0], e.name]),
    [[3, 'Sin precio'], [4, 'Gel aloe'], [5, 'Bruma']]
  );
  assert.match(res.errors[0].message, /precio/i);
  assert.match(res.errors[1].message, /categoría/i);
  assert.match(res.errors[2].message, /número/);
  const ex = db.one(`SELECT p.price, p.cost, p.stock, a.publish_online FROM products p JOIN articles a ON a.id = p.article_id WHERE a.name = 'Exfoliante'`);
  assert.deepEqual({ ...ex }, { price: 8500.5, cost: 3200, stock: 7, publish_online: 1 });
  // Sin medidas no se publica (no hay error): queda para completar.
  assert.equal((await importFile(Buffer.from('Nombre;Categoría;Precio\nToalla;Accesorios;3000', 'utf8'), 'x.csv', false)).data.created, 1);
  assert.equal(db.one(`SELECT publish_online FROM articles WHERE name = 'Toalla'`).publish_online, 0);
});

test('archivo inválido o sin columnas obligatorias', async () => {
  assert.equal((await importFile(Buffer.from('no es excel'), 'x.xlsx', true)).status, 400);
  const r = await importFile(Buffer.from('Marca;Stock\nX;1'), 'x.csv', true);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Nombre/);
});
