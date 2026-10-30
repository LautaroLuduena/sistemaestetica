const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const stock = require('./stock');
const { badRequest, notFound, conflict, round2, token } = require('../util');

const MAX_IMAGES = 3;
const MAX_ATTRIBUTES = 3;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Se setea desde server.js (envío a Tienda Nube) para evitar dependencias circulares.
let onArticleChange = () => {};
let onRemoteDelete = () => {};
function setListeners({ articleChanged, remoteDelete }) {
  if (articleChanged) onArticleChange = articleChanged;
  if (remoteDelete) onRemoteDelete = remoteDelete;
}

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

const effectivePrice = (v) => (v.promo_price && v.promo_price > 0 && v.promo_price < v.price ? v.promo_price : v.price);
const displayName = (name, values) => (values && values.length ? `${name} - ${values.join(' / ')}` : name);
const imageUrl = (img) => (img.filename ? `/uploads/${img.filename}` : img.url);

// ---------- Categorías ----------

function categoryTree() {
  const rows = db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category_id = c.id AND a.active = 1) AS articles
     FROM categories c ORDER BY c.sort, c.name`
  );
  const top = rows.filter((c) => !c.parent_id);
  return top.map((c) => ({ ...c, children: rows.filter((x) => x.parent_id === c.id) }));
}

function getCategory(id) {
  const c = db.one('SELECT * FROM categories WHERE id = ?', id);
  if (!c) throw notFound('La categoría no existe');
  return c;
}

// Devuelve [categoría, subcategoría?] para un id.
function categoryPath(id) {
  if (!id) return [];
  const c = db.one('SELECT * FROM categories WHERE id = ?', id);
  if (!c) return [];
  return c.parent_id ? [getCategory(c.parent_id), c] : [c];
}

function saveCategory({ name, parentId = null }, id = null) {
  const clean = String(name || '').trim();
  if (!clean) throw badRequest('Ingresá el nombre de la categoría');
  const parent = parentId ? getCategory(Number(parentId)) : null;
  if (parent && parent.parent_id) throw badRequest('Solo se pueden crear subcategorías dentro de una categoría principal');
  const dup = db.one('SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND parent_id IS ? AND id IS NOT ?', clean, parent ? parent.id : null, id);
  if (dup) throw conflict('Ya existe una categoría con ese nombre');
  if (id) {
    const current = getCategory(id);
    if (parent && db.one('SELECT 1 FROM categories WHERE parent_id = ?', id)) throw badRequest('Una categoría con subcategorías no puede pasar a ser subcategoría');
    if (parent && parent.id === current.id) throw badRequest('Una categoría no puede ser su propia subcategoría');
    db.run('UPDATE categories SET name = ?, parent_id = ? WHERE id = ?', clean, parent ? parent.id : null, id);
    return getCategory(id);
  }
  const res = db.run('INSERT INTO categories (name, parent_id) VALUES (?, ?)', clean, parent ? parent.id : null);
  return getCategory(Number(res.lastInsertRowid));
}

function deleteCategory(id) {
  const c = getCategory(id);
  if (db.one('SELECT 1 FROM categories WHERE parent_id = ?', id)) throw conflict('Primero eliminá o mové sus subcategorías');
  if (db.one('SELECT 1 FROM articles WHERE category_id = ?', id)) throw conflict('Hay artículos en esta categoría: cambiales la categoría antes de eliminarla');
  db.run('DELETE FROM categories WHERE id = ?', id);
  if (c.tn_category_id) onRemoteDelete(`/categories/${c.tn_category_id}`);
  return { deleted: true };
}

// ---------- Fotos ----------

function saveImageData(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m || !IMAGE_TYPES[m[1].toLowerCase()]) throw badRequest('Formato de foto no válido (usá JPG, PNG o WEBP)');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) throw badRequest('Cada foto puede pesar hasta 5 MB');
  const dir = db.uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${token(12)}.${IMAGE_TYPES[m[1].toLowerCase()]}`;
  fs.writeFileSync(path.join(dir, filename), buf);
  return filename;
}

function removeImageFile(filename) {
  if (!filename) return;
  try {
    fs.unlinkSync(path.join(db.uploadsDir(), path.basename(filename)));
  } catch {
    // ya no estaba
  }
}

function readImage(img) {
  return fs.readFileSync(path.join(db.uploadsDir(), path.basename(img.filename)));
}

// ---------- Artículos ----------

function getArticle(id) {
  const a = db.one('SELECT * FROM articles WHERE id = ?', id);
  if (!a) throw notFound('El artículo no existe');
  const [category, subcategory] = categoryPath(a.category_id);
  const variants = db
    .all('SELECT * FROM products WHERE article_id = ? AND active = 1 ORDER BY id', a.id)
    .map((v) => ({ ...v, values: parseJson(v.variant_values, []), effective_price: effectivePrice(v) }));
  const images = db.all('SELECT * FROM article_images WHERE article_id = ? ORDER BY position, id', a.id).map((i) => ({ ...i, src: imageUrl(i) }));
  return {
    ...a,
    attributes: parseJson(a.attributes, []),
    category: category || null,
    subcategory: subcategory || null,
    variants,
    images,
    stock: variants.reduce((t, v) => t + v.stock, 0),
  };
}

function listArticles({ q, categoryId, status } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(a.name LIKE ? OR a.brand LIKE ? OR EXISTS (SELECT 1 FROM products p WHERE p.article_id = a.id AND p.sku LIKE ?))');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (categoryId) {
    where.push('(a.category_id = ? OR a.category_id IN (SELECT id FROM categories WHERE parent_id = ?))');
    params.push(Number(categoryId), Number(categoryId));
  }
  if (status === 'inactive') where.push('a.active = 0');
  else if (status !== 'all') where.push('a.active = 1');
  if (status === 'low') where.push('EXISTS (SELECT 1 FROM products p WHERE p.article_id = a.id AND p.active = 1 AND p.stock <= p.min_stock)');
  if (status === 'promo') where.push('EXISTS (SELECT 1 FROM products p WHERE p.article_id = a.id AND p.active = 1 AND p.promo_price > 0 AND p.promo_price < p.price)');
  const rows = db.all(
    `SELECT a.*,
       (SELECT COALESCE(filename, url) FROM article_images i WHERE i.article_id = a.id ORDER BY position, id LIMIT 1) AS thumb_ref,
       (SELECT filename IS NOT NULL FROM article_images i WHERE i.article_id = a.id ORDER BY position, id LIMIT 1) AS thumb_local,
       (SELECT COUNT(*) FROM article_images i WHERE i.article_id = a.id) AS image_count
     FROM articles a ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.active DESC, a.name LIMIT 1000`,
    ...params
  );
  const cats = new Map(db.all('SELECT * FROM categories').map((c) => [c.id, c]));
  return rows.map((a) => {
    const variants = db
      .all('SELECT id, sku, variant_values, price, promo_price, stock, min_stock FROM products WHERE article_id = ? AND active = 1 ORDER BY id', a.id)
      .map((v) => ({ ...v, values: parseJson(v.variant_values, []), effective_price: effectivePrice(v) }));
    const cat = cats.get(a.category_id);
    const parent = cat && cat.parent_id ? cats.get(cat.parent_id) : null;
    const prices = variants.map((v) => v.price);
    const eff = variants.map((v) => v.effective_price);
    return {
      id: a.id,
      name: a.name,
      brand: a.brand,
      active: a.active,
      publish_online: a.publish_online,
      category: parent ? `${parent.name} › ${cat.name}` : cat ? cat.name : null,
      thumb: a.thumb_ref ? (a.thumb_local ? `/uploads/${a.thumb_ref}` : a.thumb_ref) : null,
      image_count: a.image_count,
      attributes: parseJson(a.attributes, []),
      variants,
      stock: variants.reduce((t, v) => t + v.stock, 0),
      low_stock: variants.some((v) => v.stock <= v.min_stock),
      price_min: prices.length ? Math.min(...prices) : 0,
      price_max: prices.length ? Math.max(...prices) : 0,
      effective_min: eff.length ? Math.min(...eff) : 0,
      on_promo: variants.some((v) => v.effective_price < v.price),
      tn_product_id: a.tn_product_id,
      tn_sync_status: a.tn_sync_status,
      tn_sync_error: a.tn_sync_error,
      tn_last_sync: a.tn_last_sync,
    };
  });
}

const optNum = (v, field) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${field} no es válido`);
  return round2(n);
};

function validate(input) {
  const name = String(input.name || '').trim();
  if (!name) throw badRequest('Ingresá el nombre del artículo');
  const categoryId = Number(input.categoryId) || null;
  if (!categoryId) throw badRequest('Elegí una categoría');
  getCategory(categoryId);

  const attributes = (Array.isArray(input.attributes) ? input.attributes : []).map((a) => String(a || '').trim()).filter(Boolean);
  if (attributes.length > MAX_ATTRIBUTES) throw badRequest(`Se pueden usar hasta ${MAX_ATTRIBUTES} tipos de variante (ej: Color, Tamaño)`);
  if (new Set(attributes.map((a) => a.toLowerCase())).size !== attributes.length) throw badRequest('Hay tipos de variante repetidos');

  const variants = Array.isArray(input.variants) ? input.variants : [];
  if (!variants.length) throw badRequest('Cargá el precio y el stock del artículo');
  if (!attributes.length && variants.length > 1) throw badRequest('Para cargar varias variantes indicá el tipo de variante (ej: Color)');
  const seen = new Set();
  const skus = new Set();
  const cleanVariants = variants.map((v, i) => {
    const values = attributes.length ? (Array.isArray(v.values) ? v.values : []).map((x) => String(x || '').trim()) : [];
    if (attributes.length && (values.length !== attributes.length || values.some((x) => !x))) {
      throw badRequest(`Completá ${attributes.join(' y ')} en todas las variantes`);
    }
    const key = values.join('|').toLowerCase();
    if (seen.has(key)) throw badRequest(`La variante "${values.join(' / ')}" está repetida`);
    seen.add(key);
    const price = optNum(v.price, 'El precio');
    if (!price) throw badRequest(attributes.length ? `Ingresá el precio de la variante ${values.join(' / ')}` : 'Ingresá el precio');
    const promo = optNum(v.promo_price, 'El precio promocional');
    if (promo !== null && promo > 0 && promo >= price) throw badRequest('El precio promocional tiene que ser menor al precio normal');
    const stockVal = v.stock === undefined || v.stock === '' || v.stock === null ? 0 : Number(v.stock);
    if (!Number.isInteger(stockVal) || stockVal < 0) throw badRequest('El stock tiene que ser un número entero, 0 o más');
    const sku = String(v.sku || '').trim() || null;
    if (sku) {
      if (skus.has(sku.toLowerCase())) throw badRequest(`El SKU ${sku} está repetido`);
      skus.add(sku.toLowerCase());
    }
    return {
      id: v.id ? Number(v.id) : null,
      index: i,
      values,
      sku,
      price,
      promo_price: promo || null,
      stock: stockVal,
      weight: optNum(v.weight, 'El peso'),
    };
  });

  const images = Array.isArray(input.images) ? input.images : [];
  if (!images.length) throw badRequest('Agregá al menos una foto del artículo');
  if (images.length > MAX_IMAGES) throw badRequest(`Se pueden cargar hasta ${MAX_IMAGES} fotos`);

  const publishOnline = input.publishOnline === false || input.publishOnline === 0 ? 0 : 1;
  const weight = optNum(input.weight, 'El peso');
  const width = optNum(input.width, 'El ancho');
  const height = optNum(input.height, 'El alto');
  const depth = optNum(input.depth, 'La profundidad');
  if (publishOnline && (!weight || !width || !height || !depth)) {
    throw badRequest('Para publicar en la tienda online completá peso, alto, ancho y profundidad (se usan para calcular el envío)');
  }
  const minStock = input.minStock === undefined || input.minStock === '' ? 0 : Number(input.minStock);
  if (!Number.isInteger(minStock) || minStock < 0) throw badRequest('El stock mínimo no es válido');
  return {
    name,
    description: String(input.description || '').trim() || null,
    brand: String(input.brand || '').trim() || null,
    categoryId,
    attributes,
    variants: cleanVariants,
    images,
    weight,
    width,
    height,
    depth,
    minStock,
    freeShipping: input.freeShipping ? 1 : 0,
    active: input.active === false || input.active === 0 ? 0 : 1,
    publishOnline,
  };
}

/**
 * Crea o actualiza un artículo con sus variantes y fotos.
 * Los cambios de stock hechos desde la ficha quedan registrados como ajustes.
 */
function saveArticle(input, { id = null, userId = null } = {}) {
  const data = validate(input || {});
  const newFiles = [];
  try {
    const articleId = db.tx(() => {
      let aid = id;
      if (aid) {
        if (!db.one('SELECT 1 FROM articles WHERE id = ?', aid)) throw notFound('El artículo no existe');
        db.run(
          `UPDATE articles SET name = ?, description = ?, brand = ?, category_id = ?, attributes = ?, weight = ?, width = ?, height = ?, depth = ?,
                  free_shipping = ?, active = ?, publish_online = ?, updated_at = datetime('now') WHERE id = ?`,
          data.name, data.description, data.brand, data.categoryId, JSON.stringify(data.attributes), data.weight, data.width, data.height, data.depth,
          data.freeShipping, data.active, data.publishOnline, aid
        );
      } else {
        const res = db.run(
          `INSERT INTO articles (name, description, brand, category_id, attributes, weight, width, height, depth, free_shipping, active, publish_online)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          data.name, data.description, data.brand, data.categoryId, JSON.stringify(data.attributes), data.weight, data.width, data.height, data.depth,
          data.freeShipping, data.active, data.publishOnline
        );
        aid = Number(res.lastInsertRowid);
      }
      const article = db.one('SELECT * FROM articles WHERE id = ?', aid);

      // Variantes
      const existing = db.all('SELECT * FROM products WHERE article_id = ? AND active = 1', aid);
      const keep = new Set();
      for (const v of data.variants) {
        if (v.sku && db.one('SELECT 1 FROM products WHERE LOWER(sku) = LOWER(?) AND id IS NOT ?', v.sku, v.id)) {
          throw conflict(`Ya existe otro artículo con el SKU ${v.sku}`);
        }
        const fields = [
          v.sku, displayName(data.name, v.values), JSON.stringify(v.values), v.price, v.promo_price, data.minStock,
          v.weight || data.weight, data.width, data.height, data.depth, data.active, data.publishOnline,
        ];
        const current = v.id ? existing.find((e) => e.id === v.id) : null;
        if (v.id && !current) throw badRequest('Una de las variantes no pertenece a este artículo');
        let pid;
        if (current) {
          db.run(
            `UPDATE products SET sku = ?, name = ?, variant_values = ?, price = ?, promo_price = ?, min_stock = ?, weight = ?, width = ?, height = ?, depth = ?,
                    active = 1, publish_online = ?, updated_at = datetime('now') WHERE id = ?`,
            ...fields.slice(0, 10), data.publishOnline, current.id
          );
          pid = current.id;
          if (current.stock !== v.stock) {
            stock.change(pid, { setTo: v.stock, type: 'adjustment', reason: 'Edición del artículo', userId, source: 'inventory' });
          }
        } else {
          const res = db.run(
            `INSERT INTO products (sku, name, variant_values, price, promo_price, min_stock, weight, width, height, depth, active, publish_online, article_id, tn_product_id, stock)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0)`,
            ...fields.slice(0, 10), data.publishOnline, aid, article.tn_product_id
          );
          pid = Number(res.lastInsertRowid);
          if (v.stock > 0) stock.change(pid, { setTo: v.stock, type: 'initial', reason: 'Alta de artículo', userId, source: 'inventory' });
        }
        keep.add(pid);
      }
      for (const old of existing.filter((e) => !keep.has(e.id))) {
        removeVariant(old);
      }

      // Fotos
      const current = db.all('SELECT * FROM article_images WHERE article_id = ?', aid);
      const keepImages = new Set();
      data.images.forEach((img, i) => {
        const position = i + 1;
        if (img.id) {
          const row = current.find((c) => c.id === Number(img.id));
          if (!row) throw badRequest('Una de las fotos no pertenece a este artículo');
          db.run('UPDATE article_images SET position = ? WHERE id = ?', position, row.id);
          keepImages.add(row.id);
        } else {
          const filename = saveImageData(img.data);
          newFiles.push(filename);
          const res = db.run('INSERT INTO article_images (article_id, filename, position) VALUES (?, ?, ?)', aid, filename, position);
          keepImages.add(Number(res.lastInsertRowid));
        }
      });
      for (const old of current.filter((c) => !keepImages.has(c.id))) {
        db.run('DELETE FROM article_images WHERE id = ?', old.id);
        if (old.tn_image_id && article.tn_product_id) onRemoteDelete(`/products/${article.tn_product_id}/images/${old.tn_image_id}`);
        if (old.filename) setImmediate(() => removeImageFile(old.filename));
      }
      return aid;
    });
    onArticleChange(articleId, { full: true });
    return getArticle(articleId);
  } catch (err) {
    // Si algo falló, se borran las fotos que se alcanzaron a guardar.
    for (const f of newFiles) removeImageFile(f);
    throw err;
  }
}

// Quita una variante: si tiene ventas se archiva (para no perder el historial), si no se borra.
function removeVariant(v) {
  const article = db.one('SELECT tn_product_id FROM articles WHERE id = ?', v.article_id);
  if (v.tn_variant_id && article && article.tn_product_id) onRemoteDelete(`/products/${article.tn_product_id}/variants/${v.tn_variant_id}`);
  if (db.one('SELECT 1 FROM sale_items WHERE product_id = ?', v.id)) {
    db.run(`UPDATE products SET active = 0, tn_variant_id = NULL, sku = NULL WHERE id = ?`, v.id);
  } else {
    db.run('DELETE FROM products WHERE id = ?', v.id);
  }
}

// Eliminar: si tiene ventas o está publicado se desactiva (y se despublica de la web); si no, se borra.
function deleteArticle(id) {
  const a = getArticle(id);
  const hasSales = db.one('SELECT 1 FROM sale_items si JOIN products p ON p.id = si.product_id WHERE p.article_id = ?', id);
  if (hasSales || a.tn_product_id) {
    db.run(`UPDATE articles SET active = 0, updated_at = datetime('now') WHERE id = ?`, id);
    onArticleChange(id, { full: true });
    return { deactivated: true };
  }
  db.tx(() => {
    db.run('DELETE FROM products WHERE article_id = ?', id);
    db.run('DELETE FROM articles WHERE id = ?', id);
  });
  for (const img of a.images) removeImageFile(img.filename);
  return { deleted: true };
}

/**
 * Aplica (o quita, con percent = 0) un descuento a todo el inventario, a una categoría (incluye
 * sus subcategorías) o a artículos puntuales. Se publica como "precio promocional" en la tienda.
 */
function applyDiscount({ percent, categoryId = null, articleIds = null }) {
  const p = Number(percent);
  if (!Number.isFinite(p) || p < 0 || p >= 100) throw badRequest('El porcentaje tiene que estar entre 0 y 99');
  const where = ['a.active = 1', 'p.active = 1'];
  const params = [];
  if (categoryId) {
    where.push('(a.category_id = ? OR a.category_id IN (SELECT id FROM categories WHERE parent_id = ?))');
    params.push(Number(categoryId), Number(categoryId));
  }
  if (Array.isArray(articleIds) && articleIds.length) {
    where.push(`a.id IN (${articleIds.map(() => '?').join(',')})`);
    params.push(...articleIds.map(Number));
  }
  const rows = db.all(`SELECT p.id, p.price, p.article_id FROM products p JOIN articles a ON a.id = p.article_id WHERE ${where.join(' AND ')}`, ...params);
  db.tx(() => {
    for (const r of rows) {
      const promo = p > 0 ? Math.round(r.price * (1 - p / 100)) : null;
      db.run(`UPDATE products SET promo_price = ?, updated_at = datetime('now') WHERE id = ?`, promo && promo < r.price ? promo : null, r.id);
    }
  });
  const articles = [...new Set(rows.map((r) => r.article_id))];
  for (const id of articles) onArticleChange(id, { full: true });
  return { variants: rows.length, articles: articles.length };
}

// Variantes para la caja (con nombre completo y precio vigente).
function sellableProducts(q = '') {
  const like = `%${q}%`;
  return db
    .all(
      `SELECT p.*, a.name AS article_name,
         (SELECT COALESCE(filename, url) FROM article_images i WHERE i.article_id = a.id ORDER BY position, id LIMIT 1) AS thumb_ref,
         (SELECT filename IS NOT NULL FROM article_images i WHERE i.article_id = a.id ORDER BY position, id LIMIT 1) AS thumb_local
       FROM products p LEFT JOIN articles a ON a.id = p.article_id
       WHERE p.active = 1 AND IFNULL(a.active, 1) = 1 AND (p.name LIKE ? OR IFNULL(p.sku, '') LIKE ? OR IFNULL(a.brand, '') LIKE ?)
       ORDER BY p.name`,
      like,
      like,
      like
    )
    .map(({ thumb_ref, thumb_local, ...p }) => ({
      ...p,
      values: parseJson(p.variant_values, []),
      effective_price: effectivePrice(p),
      thumb: thumb_ref ? (thumb_local ? `/uploads/${thumb_ref}` : thumb_ref) : null,
    }));
}

module.exports = {
  MAX_IMAGES,
  setListeners,
  effectivePrice,
  displayName,
  parseJson,
  categoryTree,
  categoryPath,
  getCategory,
  saveCategory,
  deleteCategory,
  getArticle,
  listArticles,
  saveArticle,
  deleteArticle,
  applyDiscount,
  sellableProducts,
  readImage,
  imageUrl,
};
