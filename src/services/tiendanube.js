const crypto = require('node:crypto');
const db = require('../db');
const http = require('./http');
const settings = require('../settings');
const stock = require('./stock');
const { log } = require('./log');
const { HttpError, round2 } = require('../util');

const API = 'https://api.tiendanube.com/v1';
const LANG = 'es';
const WEBHOOK_EVENTS = ['order/created', 'order/cancelled', 'product/deleted'];

function credentials() {
  const storeId = settings.get('tn_store_id');
  const accessToken = settings.get('tn_access_token');
  if (!storeId || !accessToken) throw new HttpError(503, 'Tienda Nube no está conectada');
  return { storeId, accessToken };
}

const isConfigured = () => Boolean(settings.get('tn_store_id') && settings.get('tn_access_token'));

function call(path, opts = {}) {
  const { storeId, accessToken } = credentials();
  const ua = settings.get('tn_user_agent') || `${settings.get('business_name') || 'Sistema Estetica'} (sistema-estetica)`;
  return http.json(`${API}/${storeId}${path}`, {
    ...opts,
    headers: { Authentication: `bearer ${accessToken}`, 'User-Agent': ua, ...(opts.headers || {}) },
  });
}

const text = (v) => (v && typeof v === 'object' ? v[LANG] ?? Object.values(v)[0] ?? '' : v ?? '');

// ---------- OAuth (instalación como app) ----------

function installUrl() {
  const clientId = settings.get('tn_client_id');
  if (!clientId) throw new HttpError(400, 'Cargá primero el App ID (client_id) de tu app de Tienda Nube');
  return `https://www.tiendanube.com/apps/${encodeURIComponent(clientId)}/authorize`;
}

async function exchangeCode(code) {
  const data = await http.json('https://www.tiendanube.com/apps/authorize/token', {
    method: 'POST',
    body: {
      client_id: settings.get('tn_client_id'),
      client_secret: settings.get('tn_client_secret'),
      grant_type: 'authorization_code',
      code,
    },
  });
  if (!data || !data.access_token) throw new Error(`Respuesta inesperada de Tienda Nube: ${JSON.stringify(data)}`);
  settings.set({ tn_access_token: data.access_token, tn_store_id: String(data.user_id) });
  log('tiendanube', 'info', `Tienda conectada (store_id ${data.user_id})`);
  return data;
}

// ---------- Webhooks ----------

function verifyWebhook(rawBody, signature) {
  const secret = settings.get('tn_client_secret');
  if (!secret) return true; // conexión con token manual: no hay clave para validar
  if (!signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function registerWebhooks() {
  const base = settings.publicUrl();
  if (!base.startsWith('https://')) throw new HttpError(400, 'Configurá la URL pública (https) del sistema para registrar los webhooks');
  const url = `${base}/api/webhooks/tiendanube`;
  const existing = (await call('/webhooks')) || [];
  const created = [];
  for (const event of WEBHOOK_EVENTS) {
    const same = existing.find((w) => w.event === event);
    if (same && same.url === url) continue;
    if (same) await call(`/webhooks/${same.id}`, { method: 'DELETE' });
    await call('/webhooks', { method: 'POST', body: { event, url } });
    created.push(event);
  }
  log('tiendanube', 'info', `Webhooks registrados: ${WEBHOOK_EVENTS.join(', ')}`);
  return { url, events: WEBHOOK_EVENTS, created };
}

// ---------- Productos: local -> Tienda Nube ----------

function variantPayload(p, { includePrice }) {
  const v = { stock_management: true, stock: Math.max(0, p.stock) };
  if (includePrice) v.price = round2(p.price).toFixed(2);
  if (p.sku) v.sku = p.sku;
  return v;
}

async function pushProduct(productId, { stockOnly = false } = {}) {
  const p = stock.getProduct(productId);
  const includePrice = settings.get('tn_sync_price') === '1';
  const published = Boolean(p.active && p.publish_online);
  try {
    if (!p.tn_product_id) {
      if (!published) return null; // no se publica en la web
      const created = await call('/products', {
        method: 'POST',
        body: {
          name: { [LANG]: p.name },
          description: { [LANG]: p.description || '' },
          published: true,
          variants: [{ ...variantPayload(p, { includePrice: true }) }],
        },
      });
      const variant = created.variants && created.variants[0];
      db.run(
        `UPDATE products SET tn_product_id = ?, tn_variant_id = ?, tn_sync_status = 'ok', tn_sync_error = NULL, tn_last_sync = datetime('now') WHERE id = ?`,
        String(created.id),
        variant ? String(variant.id) : null,
        p.id
      );
      log('tiendanube', 'info', `Producto creado en Tienda Nube: ${p.name}`);
      return created;
    }
    if (!stockOnly) {
      await call(`/products/${p.tn_product_id}`, {
        method: 'PUT',
        body: { name: { [LANG]: p.name }, description: { [LANG]: p.description || '' }, published },
      });
    }
    if (p.tn_variant_id) {
      await call(`/products/${p.tn_product_id}/variants/${p.tn_variant_id}`, {
        method: 'PUT',
        body: stockOnly ? { stock_management: true, stock: Math.max(0, p.stock) } : variantPayload(p, { includePrice }),
      });
    }
    db.run(`UPDATE products SET tn_sync_status = 'ok', tn_sync_error = NULL, tn_last_sync = datetime('now') WHERE id = ?`, p.id);
    return true;
  } catch (err) {
    if (err.status === 404 && p.tn_product_id) {
      // Lo borraron en Tienda Nube: se desvincula para poder volver a crearlo.
      db.run(`UPDATE products SET tn_product_id = NULL, tn_variant_id = NULL, tn_sync_status = 'error', tn_sync_error = ? WHERE id = ?`, 'El producto no existe más en Tienda Nube (se desvinculó)', p.id);
    } else {
      db.run(`UPDATE products SET tn_sync_status = 'error', tn_sync_error = ? WHERE id = ?`, err.message.slice(0, 500), p.id);
    }
    log('tiendanube', 'error', `No se pudo sincronizar "${p.name}": ${err.message}`);
    throw err;
  }
}

// Cola simple: agrupa cambios y los envía de a uno (Tienda Nube limita ~2 pedidos por segundo).
const queue = new Map();
let running = false;

function schedulePush(productId, { stockOnly = false } = {}) {
  if (!isConfigured() || settings.get('tn_auto_sync') !== '1') return;
  const prev = queue.get(productId);
  queue.set(productId, { stockOnly: prev ? prev.stockOnly && stockOnly : stockOnly });
  if (!running) setImmediate(drain);
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.size) {
      const [id, opts] = queue.entries().next().value;
      queue.delete(id);
      try {
        if (db.one('SELECT 1 FROM products WHERE id = ?', id)) await pushProduct(id, opts);
      } catch {
        // ya quedó registrado en el producto y en el log
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    running = false;
  }
}

const pendingQueue = () => queue.size + (running ? 1 : 0);

async function pushAll() {
  const ids = db.all('SELECT id FROM products WHERE active = 1 OR tn_product_id IS NOT NULL').map((r) => r.id);
  let ok = 0;
  const errors = [];
  for (const id of ids) {
    try {
      const res = await pushProduct(id);
      if (res !== null) ok++;
    } catch (err) {
      errors.push(err.message);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { total: ids.length, ok, errors: errors.length };
}

// ---------- Productos: Tienda Nube -> local ----------

async function fetchAllProducts() {
  const out = [];
  for (let page = 1; page < 100; page++) {
    let batch;
    try {
      batch = await call(`/products?per_page=200&page=${page}`);
    } catch (err) {
      if (err.status === 404) break; // Tienda Nube responde 404 después de la última página
      throw err;
    }
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < 200) break;
  }
  return out;
}

/**
 * Importa productos de Tienda Nube. Cada variante es un producto local.
 * Vincula por id de Tienda Nube o por SKU; si no existe, lo crea.
 * mode: 'local' => mantiene el stock local (y lo envía a la web); 'remote' => toma el stock de la web.
 */
async function importProducts({ stockFrom = 'remote' } = {}) {
  const remote = await fetchAllProducts();
  const stats = { created: 0, linked: 0, updated: 0 };
  const toPush = [];
  db.tx(() => {
    for (const rp of remote) {
      const baseName = text(rp.name);
      for (const v of rp.variants || []) {
        const values = (v.values || []).map(text).filter(Boolean);
        const name = values.length ? `${baseName} - ${values.join(' / ')}` : baseName;
        const remoteStock = v.stock === null || v.stock === undefined ? null : Number(v.stock);
        let local = db.one('SELECT * FROM products WHERE tn_product_id = ? AND tn_variant_id = ?', String(rp.id), String(v.id));
        if (!local && v.sku) local = db.one('SELECT * FROM products WHERE sku = ?', v.sku);
        if (!local) {
          const res = db.run(
            `INSERT INTO products (sku, name, description, price, stock, tn_product_id, tn_variant_id, tn_sync_status, tn_last_sync)
             VALUES (?, ?, ?, ?, 0, ?, ?, 'ok', datetime('now'))`,
            v.sku || null,
            name,
            stripHtml(text(rp.description)),
            round2(v.price || 0),
            String(rp.id),
            String(v.id)
          );
          const id = Number(res.lastInsertRowid);
          if (remoteStock) stock.change(id, { setTo: Math.max(0, remoteStock), type: 'tiendanube_import', reason: 'Importación inicial', source: 'tiendanube' });
          if (remoteStock === null) toPush.push(id); // la web tenía stock infinito: pasa a manejar stock
          stats.created++;
          continue;
        }
        const wasLinked = local.tn_product_id === String(rp.id);
        db.run(
          `UPDATE products SET tn_product_id = ?, tn_variant_id = ?, tn_sync_status = 'ok', tn_sync_error = NULL, tn_last_sync = datetime('now') WHERE id = ?`,
          String(rp.id),
          String(v.id),
          local.id
        );
        if (stockFrom === 'remote' && remoteStock !== null && remoteStock !== local.stock) {
          stock.change(local.id, { setTo: Math.max(0, remoteStock), type: 'tiendanube_import', reason: 'Stock tomado de Tienda Nube', source: 'tiendanube' });
          stats.updated++;
        } else if (stockFrom === 'local' || remoteStock === null) {
          toPush.push(local.id);
        }
        if (!wasLinked) stats.linked++;
      }
    }
  });
  for (const id of toPush) schedulePush(id, { stockOnly: true });
  log('tiendanube', 'info', `Importación: ${stats.created} nuevos, ${stats.linked} vinculados, ${stats.updated} con stock actualizado`);
  return { ...stats, remoteProducts: remote.length };
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

// ---------- Órdenes de Tienda Nube -> stock local ----------

function findLocalForItem(item) {
  let p = null;
  if (item.variant_id) p = db.one('SELECT * FROM products WHERE tn_product_id = ? AND tn_variant_id = ?', String(item.product_id), String(item.variant_id));
  if (!p && item.sku) p = db.one('SELECT * FROM products WHERE sku = ?', item.sku);
  return p;
}

/**
 * Aplica (o revierte) una orden de Tienda Nube sobre el stock local.
 * Tienda Nube ya descontó su propio stock, así que estos movimientos no se reenvían.
 */
function applyOrder(order, action) {
  return db.tx(() => {
    const orderId = String(order.id);
    const current = db.one('SELECT * FROM tn_orders WHERE order_id = ?', orderId);
    if (action === 'apply' && current) return { skipped: true };
    if (action === 'revert' && (!current || current.status !== 'applied')) return { skipped: true };

    const missing = [];
    for (const item of order.products || []) {
      const local = findLocalForItem(item);
      const qty = Number(item.quantity) || 0;
      if (!local || !qty) {
        if (!local) missing.push(item.name || item.sku || item.product_id);
        continue;
      }
      stock.change(local.id, {
        delta: action === 'apply' ? -qty : qty,
        type: action === 'apply' ? 'tiendanube_order' : 'tiendanube_cancel',
        reason: `Orden #${order.number || orderId}`,
        reference: `tn-order:${orderId}`,
        allowNegative: true,
        source: 'tiendanube',
      });
    }
    db.run(
      `INSERT INTO tn_orders (order_id, number, status) VALUES (?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`,
      orderId,
      order.number ? String(order.number) : null,
      action === 'apply' ? 'applied' : 'reverted'
    );
    if (missing.length) log('tiendanube', 'warn', `Orden #${order.number || orderId}: productos sin vincular: ${missing.join(', ')}`);
    return { applied: true, missing };
  });
}

async function handleWebhook(payload) {
  const { event, id } = payload || {};
  if (String(payload.store_id) !== String(settings.get('tn_store_id'))) {
    log('tiendanube', 'warn', `Webhook de otra tienda ignorado (store_id ${payload.store_id})`);
    return { ignored: true };
  }
  if (event === 'order/created' || event === 'order/paid') {
    const order = await call(`/orders/${id}`);
    const res = applyOrder(order, 'apply');
    if (!res.skipped) log('tiendanube', 'info', `Orden #${order.number || id} descontada del stock`);
    return res;
  }
  if (event === 'order/cancelled') {
    const order = await call(`/orders/${id}`);
    const res = applyOrder(order, 'revert');
    if (!res.skipped) log('tiendanube', 'info', `Orden #${order.number || id} cancelada: stock repuesto`);
    return res;
  }
  if (event === 'product/deleted') {
    const n = db.run(`UPDATE products SET tn_product_id = NULL, tn_variant_id = NULL, tn_sync_status = NULL WHERE tn_product_id = ?`, String(id)).changes;
    if (n) log('tiendanube', 'info', `Producto ${id} eliminado en Tienda Nube: desvinculado`);
    return { unlinked: n };
  }
  return { ignored: true };
}

async function testConnection() {
  const store = await call('/store');
  return { id: store.id, name: text(store.name), url: store.url_with_protocol || store.original_domain };
}

module.exports = {
  WEBHOOK_EVENTS,
  isConfigured,
  installUrl,
  exchangeCode,
  verifyWebhook,
  registerWebhooks,
  pushProduct,
  schedulePush,
  pendingQueue,
  pushAll,
  importProducts,
  applyOrder,
  handleWebhook,
  testConnection,
};
