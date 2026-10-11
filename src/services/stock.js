const db = require('../db');
const { badRequest, notFound, conflict, int } = require('../util');

// Se setea desde server.js para no crear una dependencia circular con tiendanube.js.
let onLocalChange = () => {};
function setChangeListener(fn) {
  onLocalChange = fn;
}

const MOVEMENT_TYPES = {
  initial: 'Stock inicial',
  adjustment: 'Ajuste',
  sale: 'Venta en local',
  sale_cancel: 'Anulación de venta',
  tiendanube_order: 'Venta Tienda Nube',
  tiendanube_cancel: 'Cancelación Tienda Nube',
  tiendanube_import: 'Importado de Tienda Nube',
};

function getProduct(id) {
  const p = db.one('SELECT * FROM products WHERE id = ?', id);
  if (!p) throw notFound('El producto no existe');
  return p;
}

/**
 * Cambia el stock de un producto y registra el movimiento.
 *  - delta: suma/resta (ej. -2)
 *  - setTo: fija el stock en un valor absoluto (conteo físico)
 * Si source === 'tiendanube' no se vuelve a enviar el stock a Tienda Nube (ya está actualizado allá).
 */
function change(productId, { delta, setTo, type = 'adjustment', reason = null, reference = null, userId = null, allowNegative = false, source = 'local' }) {
  if (!MOVEMENT_TYPES[type]) throw badRequest('Tipo de movimiento inválido');
  const result = db.tx(() => {
    const product = getProduct(productId);
    let qty;
    if (setTo !== undefined && setTo !== null && setTo !== '') {
      const target = int(setTo, 'cantidad');
      if (target < 0) throw badRequest('El stock no puede ser negativo');
      qty = target - product.stock;
    } else {
      qty = int(delta, 'cantidad');
    }
    if (qty === 0 && type === 'adjustment') return { product, movement: null };
    const after = product.stock + qty;
    if (after < 0 && !allowNegative) {
      throw conflict(`Stock insuficiente de "${product.name}" (disponible: ${product.stock})`);
    }
    db.run(`UPDATE products SET stock = ?, updated_at = datetime('now') WHERE id = ?`, after, product.id);
    const mv = db.run(
      `INSERT INTO stock_movements (product_id, quantity, stock_after, type, reason, reference, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      product.id,
      qty,
      after,
      type,
      reason,
      reference,
      userId
    );
    return { product: getProduct(product.id), movement: Number(mv.lastInsertRowid) };
  });
  if (result.movement && source !== 'tiendanube') onLocalChange(productId, { stockOnly: true });
  return result.product;
}

function movements({ productId, limit = 200 }) {
  return db.all(
    `SELECT m.*, p.name AS product_name, p.sku, u.username
     FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
     ${productId ? 'WHERE m.product_id = ?' : ''}
     ORDER BY m.id DESC LIMIT ?`,
    ...(productId ? [productId, limit] : [limit])
  );
}

module.exports = { MOVEMENT_TYPES, getProduct, change, movements, setChangeListener, notifyChange: (id, opts) => onLocalChange(id, opts) };
