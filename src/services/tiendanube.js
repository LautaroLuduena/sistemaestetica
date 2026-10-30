const crypto = require('node:crypto');
const db = require('../db');
const http = require('./http');
const settings = require('../settings');
const stock = require('./stock');
const { log } = require('./log');
const { HttpError, round2 } = require('../util');

const API = 'https://api.tiendanube.com/v1';
const LANG = 'es';
const WEBHOOK_EVENTS = ['order/created', 'order/updated', 'order/paid', 'order/packed', 'order/fulfilled', 'order/cancelled', 'product/deleted'];

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
  // Las órdenes anteriores a este momento se importan sin tocar el stock.
  if (!settings.get('tn_orders_since')) settings.set({ tn_orders_since: require('../util').sqlNow() });
  log('tiendanube', 'info', `Webhooks registrados: ${WEBHOOK_EVENTS.join(', ')}`);
  return { url, events: WEBHOOK_EVENTS, created };
}

// ---------- Artículos: local -> Tienda Nube ----------

const inventory = () => require('./inventory');
const sleep = (ms) => new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 0 : ms));

// Texto plano del sistema -> HTML simple para la tienda (párrafos y saltos de línea).
function toHtml(textValue) {
  if (!textValue) return '';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(textValue)
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// HTML de la tienda -> texto plano conservando párrafos.
function fromHtml(html) {
  return (
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() || null
  );
}


// Crea en Tienda Nube la categoría (y su categoría padre) si todavía no existe.
async function ensureCategory(categoryId) {
  const c = db.one('SELECT * FROM categories WHERE id = ?', categoryId);
  if (!c) return null;
  if (c.tn_category_id) return c.tn_category_id;
  const parentTn = c.parent_id ? await ensureCategory(c.parent_id) : null;
  const created = await call('/categories', { method: 'POST', body: { name: { [LANG]: c.name }, parent: parentTn ? Number(parentTn) : null } });
  db.run('UPDATE categories SET tn_category_id = ? WHERE id = ?', String(created.id), c.id);
  return String(created.id);
}

async function updateCategory(categoryId) {
  if (!isConfigured()) return;
  const c = db.one('SELECT * FROM categories WHERE id = ?', categoryId);
  if (!c || !c.tn_category_id) return;
  const parent = c.parent_id ? db.one('SELECT tn_category_id FROM categories WHERE id = ?', c.parent_id) : null;
  try {
    await call(`/categories/${c.tn_category_id}`, { method: 'PUT', body: { name: { [LANG]: c.name }, parent: parent && parent.tn_category_id ? Number(parent.tn_category_id) : null } });
  } catch (err) {
    log('tiendanube', 'error', `No se pudo actualizar la categoría "${c.name}": ${err.message}`);
  }
}

function variantBody(v, { includePrice }) {
  const body = {
    stock_management: true,
    stock: Math.max(0, v.stock),
    sku: v.sku || null,
    weight: v.weight ? String(v.weight) : null,
    width: v.width ? String(v.width) : null,
    height: v.height ? String(v.height) : null,
    depth: v.depth ? String(v.depth) : null,
  };
  if (v.values && v.values.length) body.values = v.values.map((x) => ({ [LANG]: x }));
  // Costo: Tienda Nube lo guarda como dato privado (no se muestra a los clientes).
  if (v.cost !== null && v.cost !== undefined) body.cost = round2(v.cost).toFixed(2);
  if (includePrice) {
    body.price = round2(v.price).toFixed(2);
    body.promotional_price = v.promo_price && v.promo_price < v.price ? round2(v.promo_price).toFixed(2) : null;
  }
  return body;
}

async function productBody(a) {
  const categories = [];
  if (a.category_id) {
    for (const c of inventory().categoryPath(a.category_id)) {
      const id = await ensureCategory(c.id);
      if (id) categories.push(Number(id));
    }
  }
  return {
    name: { [LANG]: a.name },
    description: { [LANG]: toHtml(a.description) },
    brand: a.brand || null,
    published: Boolean(a.active && a.publish_online),
    free_shipping: Boolean(a.free_shipping),
    categories,
    attributes: a.attributes.map((x) => ({ [LANG]: x })),
  };
}

function imageBody(img) {
  if (img.filename) {
    return { attachment: inventory().readImage(img).toString('base64'), filename: img.filename, position: img.position };
  }
  return { src: img.url, position: img.position };
}

async function syncImages(a) {
  for (const img of a.images) {
    if (!img.tn_image_id) {
      const created = await call(`/products/${a.tn_product_id}/images`, { method: 'POST', body: imageBody(img) });
      db.run('UPDATE article_images SET tn_image_id = ?, tn_position = ? WHERE id = ?', String(created.id), img.position, img.id);
      await sleep(300);
    } else if (img.tn_position !== img.position) {
      await call(`/products/${a.tn_product_id}/images/${img.tn_image_id}`, { method: 'PUT', body: { position: img.position } });
      db.run('UPDATE article_images SET tn_position = ? WHERE id = ?', img.position, img.id);
    }
  }
}

// Busca la variante remota que corresponde a una local (por SKU o por valores).
function matchRemoteVariant(remoteVariants, v, used) {
  const key = (vals) => (vals || []).map((x) => String(text(x)).toLowerCase()).join('|');
  return (
    remoteVariants.find((r) => !used.has(r.id) && v.sku && r.sku === v.sku) ||
    remoteVariants.find((r) => !used.has(r.id) && key(r.values) === key(v.values.map((x) => ({ [LANG]: x }))))
  );
}

async function createRemote(a) {
  const body = await productBody(a);
  body.variants = a.variants.map((v) => variantBody(v, { includePrice: true }));
  const created = await call('/products', { method: 'POST', body });
  const used = new Set();
  db.tx(() => {
    db.run(`UPDATE articles SET tn_product_id = ?, tn_attributes = ? WHERE id = ?`, String(created.id), JSON.stringify(a.attributes), a.id);
    a.variants.forEach((v, i) => {
      const remoteV = matchRemoteVariant(created.variants || [], v, used) || (created.variants || [])[i];
      if (remoteV) used.add(remoteV.id);
      db.run('UPDATE products SET tn_product_id = ?, tn_variant_id = ? WHERE id = ?', String(created.id), remoteV ? String(remoteV.id) : null, v.id);
    });
    db.run('UPDATE article_images SET tn_image_id = NULL, tn_position = NULL WHERE article_id = ?', a.id);
  });
  log('tiendanube', 'info', `Artículo publicado en Tienda Nube: ${a.name}`);
  return created;
}

/**
 * Envía un artículo completo a Tienda Nube (o solo el stock de algunas variantes).
 */
async function pushArticle(articleId, { stockOnly = false, variantIds = null } = {}) {
  let a = inventory().getArticle(articleId);
  const includePrice = settings.get('tn_sync_price') === '1';
  const published = Boolean(a.active && a.publish_online);
  try {
    if (!a.tn_product_id) {
      if (!published) return null; // no se publica en la web
      await createRemote(a);
      a = inventory().getArticle(articleId);
      await syncImages(a);
    } else if (stockOnly) {
      for (const v of a.variants) {
        if (!v.tn_variant_id || (variantIds && !variantIds.has(v.id))) continue;
        await call(`/products/${a.tn_product_id}/variants/${v.tn_variant_id}`, { method: 'PUT', body: { stock_management: true, stock: Math.max(0, v.stock) } });
      }
    } else {
      const remoteAttrs = inventory().parseJson(a.tn_attributes, null);
      if (remoteAttrs && remoteAttrs.length !== a.attributes.length && a.variants.length) {
        // Cambió la estructura de variantes (ej. se agregó "Color"): Tienda Nube no permite
        // transformarla, así que se vuelve a publicar el producto.
        await call(`/products/${a.tn_product_id}`, { method: 'DELETE' }).catch((err) => {
          if (err.status !== 404) throw err;
        });
        log('tiendanube', 'warn', `"${a.name}": cambiaron los tipos de variante, se vuelve a publicar el producto`);
        await createRemote(a);
        a = inventory().getArticle(articleId);
        await syncImages(a);
      } else {
        await call(`/products/${a.tn_product_id}`, { method: 'PUT', body: await productBody(a) });
        db.run('UPDATE articles SET tn_attributes = ? WHERE id = ?', JSON.stringify(a.attributes), a.id);
        for (const v of a.variants) {
          if (v.tn_variant_id) {
            await call(`/products/${a.tn_product_id}/variants/${v.tn_variant_id}`, { method: 'PUT', body: variantBody(v, { includePrice }) });
          } else {
            const created = await call(`/products/${a.tn_product_id}/variants`, { method: 'POST', body: variantBody(v, { includePrice: true }) });
            db.run('UPDATE products SET tn_product_id = ?, tn_variant_id = ? WHERE id = ?', a.tn_product_id, String(created.id), v.id);
          }
          await sleep(200);
        }
        await syncImages(a);
      }
    }
    db.run(`UPDATE articles SET tn_sync_status = 'ok', tn_sync_error = NULL, tn_last_sync = datetime('now') WHERE id = ?`, a.id);
    return true;
  } catch (err) {
    const message = err.data && err.data.description ? `${err.message}` : err.message;
    if (err.status === 404 && a.tn_product_id && !stockOnly) {
      // Lo borraron en Tienda Nube: se desvincula para volver a publicarlo.
      db.tx(() => {
        db.run(`UPDATE articles SET tn_product_id = NULL, tn_attributes = NULL, tn_sync_status = 'error', tn_sync_error = ? WHERE id = ?`, 'El producto no existía más en Tienda Nube: se va a volver a publicar', a.id);
        db.run('UPDATE products SET tn_product_id = NULL, tn_variant_id = NULL WHERE article_id = ?', a.id);
        db.run('UPDATE article_images SET tn_image_id = NULL, tn_position = NULL WHERE article_id = ?', a.id);
      });
    } else {
      db.run(`UPDATE articles SET tn_sync_status = 'error', tn_sync_error = ? WHERE id = ?`, String(message).slice(0, 500), a.id);
    }
    log('tiendanube', 'error', `No se pudo sincronizar "${a.name}": ${message}`);
    throw err;
  }
}

// Borrados pendientes (variantes, fotos, categorías): se reintentan hasta que Tienda Nube los confirme.
function queueRemoteDelete(pathToDelete) {
  db.run('INSERT OR IGNORE INTO tn_pending_deletes (path) VALUES (?)', pathToDelete);
  if (isConfigured() && !running) setImmediate(drain);
}

async function processDeletes() {
  for (const row of db.all('SELECT * FROM tn_pending_deletes ORDER BY id LIMIT 50')) {
    try {
      await call(row.path, { method: 'DELETE' });
    } catch (err) {
      if (err.status !== 404) {
        log('tiendanube', 'error', `No se pudo borrar ${row.path} en Tienda Nube: ${err.message}`);
        continue;
      }
    }
    db.run('DELETE FROM tn_pending_deletes WHERE id = ?', row.id);
    await sleep(300);
  }
}

// Cola: agrupa los cambios por artículo y los envía de a uno (Tienda Nube limita ~2 pedidos por segundo).
const queue = new Map();
let running = false;

function scheduleArticle(articleId, { stockOnly = false, variantId = null } = {}) {
  if (!isConfigured() || settings.get('tn_auto_sync') !== '1' || !articleId) return;
  const prev = queue.get(articleId);
  const next = { stockOnly: prev ? prev.stockOnly && stockOnly : stockOnly, variantIds: prev ? prev.variantIds : new Set() };
  if (variantId) next.variantIds.add(variantId);
  queue.set(articleId, next);
  if (!running) setImmediate(drain);
}

// Se llama cuando cambia el stock de una variante (venta, ajuste, anulación).
function schedulePush(productId, { stockOnly = false } = {}) {
  const row = db.one('SELECT article_id FROM products WHERE id = ?', productId);
  if (row) scheduleArticle(row.article_id, { stockOnly, variantId: productId });
}

async function drain() {
  if (running) return;
  running = true;
  try {
    await processDeletes();
    while (queue.size) {
      const [id, opts] = queue.entries().next().value;
      queue.delete(id);
      try {
        if (db.one('SELECT 1 FROM articles WHERE id = ?', id)) {
          await pushArticle(id, { stockOnly: opts.stockOnly, variantIds: opts.variantIds.size ? opts.variantIds : null });
        }
      } catch {
        // ya quedó registrado en el artículo y en el log
      }
      await sleep(400);
    }
  } finally {
    running = false;
  }
}

const pendingQueue = () => queue.size + (running ? 1 : 0);

async function pushAll() {
  await processDeletes();
  const ids = db.all('SELECT id FROM articles WHERE active = 1 OR tn_product_id IS NOT NULL').map((r) => r.id);
  let ok = 0;
  const errors = [];
  for (const id of ids) {
    try {
      const res = await pushArticle(id);
      if (res !== null) ok++;
    } catch (err) {
      errors.push(err.message);
    }
    await sleep(400);
  }
  return { total: ids.length, ok, errors: errors.length };
}

// ---------- Artículos: Tienda Nube -> local ----------

async function fetchAll(resource) {
  const out = [];
  for (let page = 1; page < 100; page++) {
    let batch;
    try {
      batch = await call(`/${resource}?per_page=200&page=${page}`);
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

// Trae las categorías de la tienda (2 niveles: categoría > subcategoría). Devuelve Map idRemoto -> idLocal.
function importCategories(remote) {
  const byId = new Map(remote.map((c) => [String(c.id), c]));
  const depthOf = (c) => (c.parent && byId.has(String(c.parent)) ? 1 + depthOf(byId.get(String(c.parent))) : 0);
  const map = new Map();
  const sorted = [...remote].sort((x, y) => depthOf(x) - depthOf(y));
  for (const c of sorted) {
    const name = text(c.name).trim();
    if (!name) continue;
    let local = db.one('SELECT * FROM categories WHERE tn_category_id = ?', String(c.id));
    // Categorías de más de 2 niveles se cuelgan de la categoría principal.
    let parentLocal = null;
    if (c.parent && byId.has(String(c.parent))) {
      let top = byId.get(String(c.parent));
      while (top.parent && byId.has(String(top.parent))) top = byId.get(String(top.parent));
      parentLocal = map.get(String(top.id)) || null;
    }
    if (!local) local = db.one('SELECT * FROM categories WHERE LOWER(name) = LOWER(?) AND parent_id IS ?', name, parentLocal);
    if (!local) {
      const res = db.run('INSERT INTO categories (name, parent_id, tn_category_id) VALUES (?, ?, ?)', name, parentLocal, String(c.id));
      local = { id: Number(res.lastInsertRowid) };
    } else if (!local.tn_category_id) {
      db.run('UPDATE categories SET tn_category_id = ? WHERE id = ?', String(c.id), local.id);
    }
    map.set(String(c.id), local.id);
  }
  return map;
}

/**
 * Importa los productos de Tienda Nube como artículos (con variantes, fotos, categorías y medidas).
 * Vincula por id de Tienda Nube o por SKU; si no existe, lo crea.
 * stockFrom: 'remote' => toma el stock de la web; 'local' => mantiene el del sistema y lo envía a la web.
 */
async function importProducts({ stockFrom = 'remote' } = {}) {
  const [remoteCats, remote] = [await fetchAll('categories'), await fetchAll('products')];
  const stats = { created: 0, linked: 0, updated: 0 };
  const toPush = [];
  db.tx(() => {
    const catMap = importCategories(remoteCats);
    for (const rp of remote) {
      const rVariants = rp.variants || [];
      // Artículo local: por id de Tienda Nube o por el SKU de alguna variante.
      let article = db.one('SELECT * FROM articles WHERE tn_product_id = ?', String(rp.id));
      if (!article) {
        for (const v of rVariants) {
          const p = v.sku ? db.one('SELECT article_id FROM products WHERE sku = ? AND article_id IS NOT NULL', v.sku) : null;
          if (p) {
            article = db.one('SELECT * FROM articles WHERE id = ?', p.article_id);
            break;
          }
        }
      }
      const attributes = (rp.attributes || []).map(text).filter(Boolean);
      const catIds = (rp.categories || []).map((c) => catMap.get(String(c.id || c))).filter(Boolean);
      const sub = catIds.find((id) => db.one('SELECT 1 FROM categories WHERE id = ? AND parent_id IS NOT NULL', id));
      const categoryId = sub || catIds[0] || (article ? article.category_id : null);
      const first = rVariants[0] || {};
      const num = (x) => (x === null || x === undefined || x === '' ? null : round2(Number(x)) || null);
      const fields = [
        text(rp.name) || 'Sin nombre',
        fromHtml(text(rp.description)),
        rp.brand || null,
        categoryId,
        JSON.stringify(attributes),
        num(first.weight),
        num(first.width),
        num(first.height),
        num(first.depth),
        rp.free_shipping ? 1 : 0,
        rp.published === false ? 0 : 1,
        String(rp.id),
        JSON.stringify(attributes),
      ];
      let isNew = false;
      if (article) {
        if (article.tn_product_id !== String(rp.id)) stats.linked++;
        db.run(
          `UPDATE articles SET name = ?, description = ?, brand = ?, category_id = ?, attributes = ?, weight = ?, width = ?, height = ?, depth = ?,
                  free_shipping = ?, publish_online = ?, tn_product_id = ?, tn_attributes = ?, tn_sync_status = 'ok', tn_sync_error = NULL,
                  tn_last_sync = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
          ...fields,
          article.id
        );
      } else {
        const res = db.run(
          `INSERT INTO articles (name, description, brand, category_id, attributes, weight, width, height, depth, free_shipping, publish_online,
                                 tn_product_id, tn_attributes, tn_sync_status, tn_last_sync)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', datetime('now'))`,
          ...fields
        );
        article = { id: Number(res.lastInsertRowid) };
        isNew = true;
        stats.created++;
      }

      // Fotos (se guardan como links a la imagen de la tienda)
      for (const img of rp.images || []) {
        const exists = db.one('SELECT id FROM article_images WHERE article_id = ? AND tn_image_id = ?', article.id, String(img.id));
        if (exists) db.run('UPDATE article_images SET url = COALESCE(url, ?), position = ?, tn_position = ? WHERE id = ?', img.src, img.position || 1, img.position || 1, exists.id);
        else db.run('INSERT INTO article_images (article_id, url, position, tn_image_id, tn_position) VALUES (?, ?, ?, ?, ?)', article.id, img.src, img.position || 1, String(img.id), img.position || 1);
      }

      // Variantes
      for (const v of rVariants) {
        const values = (v.values || []).map(text).filter(Boolean);
        const remoteStock = v.stock === null || v.stock === undefined ? null : Number(v.stock);
        let local = db.one('SELECT * FROM products WHERE tn_product_id = ? AND tn_variant_id = ?', String(rp.id), String(v.id));
        if (!local && v.sku) local = db.one('SELECT * FROM products WHERE sku = ?', v.sku);
        const name = values.length ? `${text(rp.name)} - ${values.join(' / ')}` : text(rp.name);
        const promo = num(v.promotional_price);
        const vf = [v.sku || null, name, JSON.stringify(values), round2(v.price || 0), promo && promo < Number(v.price) ? promo : null,
          num(v.weight), num(v.width), num(v.height), num(v.depth), article.id, String(rp.id), String(v.id)];
        const remoteCost = num(v.cost);
        if (!local) {
          const res = db.run(
            `INSERT INTO products (sku, name, variant_values, price, promo_price, weight, width, height, depth, article_id, tn_product_id, tn_variant_id, stock)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            ...vf
          );
          const id = Number(res.lastInsertRowid);
          if (remoteCost) db.run('UPDATE products SET cost = ? WHERE id = ?', remoteCost, id);
          if (remoteStock) stock.change(id, { setTo: Math.max(0, remoteStock), type: 'tiendanube_import', reason: 'Importación inicial', source: 'tiendanube' });
          if (remoteStock === null) toPush.push(id); // la web tenía stock infinito: pasa a manejar stock
          if (!isNew) stats.updated++;
          continue;
        }
        db.run(
          `UPDATE products SET sku = ?, name = ?, variant_values = ?, price = ?, promo_price = ?, weight = ?, width = ?, height = ?, depth = ?,
                  article_id = ?, tn_product_id = ?, tn_variant_id = ?, active = 1, updated_at = datetime('now') WHERE id = ?`,
          ...vf,
          local.id
        );
        if (remoteCost && (local.cost === null || local.cost === undefined)) db.run('UPDATE products SET cost = ? WHERE id = ?', remoteCost, local.id);
        if (stockFrom === 'remote' && remoteStock !== null && remoteStock !== local.stock) {
          stock.change(local.id, { setTo: Math.max(0, remoteStock), type: 'tiendanube_import', reason: 'Stock tomado de Tienda Nube', source: 'tiendanube' });
          stats.updated++;
        } else if (stockFrom === 'local' || remoteStock === null) {
          toPush.push(local.id);
        }
      }
    }
  });
  for (const id of toPush) schedulePush(id, { stockOnly: true });
  log('tiendanube', 'info', `Importación: ${stats.created} artículos nuevos, ${stats.linked} vinculados, ${stats.updated} actualizados`);
  return { ...stats, remoteProducts: remote.length, categories: remoteCats.length };
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
  if (String(event || '').startsWith('order/')) {
    // Se guarda la venta completa en "Ventas web" y se mueve el stock si corresponde.
    const weborders = require('./weborders');
    return { webOrderId: await weborders.handleEvent(event, id) };
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
  api: call,
  findLocalForItem,
  isConfigured,
  installUrl,
  exchangeCode,
  verifyWebhook,
  registerWebhooks,
  pushArticle,
  schedulePush,
  scheduleArticle,
  queueRemoteDelete,
  updateCategory,
  toHtml,
  fromHtml,
  pendingQueue,
  pushAll,
  importProducts,
  applyOrder,
  handleWebhook,
  testConnection,
};
