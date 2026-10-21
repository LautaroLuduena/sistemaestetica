const db = require('../db');
const settings = require('../settings');
const tn = require('./tiendanube');
const mp = require('./mercadopago');
const agenda = require('./agenda');
const { log } = require('./log');
const { HttpError, notFound, round2, sqlNow } = require('../util');

const text = (v) => (v && typeof v === 'object' ? v.es ?? Object.values(v)[0] ?? '' : v ?? '');
const num = (v) => (v === null || v === undefined || v === '' ? null : round2(Number(v)));

// Tienda Nube manda fechas como "2026-10-20T15:30:00+0000": se pasan a UTC en formato SQLite.
function toSql(date) {
  if (!date) return null;
  const d = new Date(String(date).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace('T', ' ').slice(0, 19);
}

function formatAddress(a) {
  if (!a) return null;
  const street = [a.address, a.number].filter(Boolean).join(' ');
  const parts = [street + (a.floor ? `, ${a.floor}` : ''), a.locality].filter(Boolean);
  return parts.join(' - ') || null;
}

function paymentDetail(order) {
  const d = order.payment_details || {};
  const methods = { credit_card: 'Tarjeta de crédito', debit_card: 'Tarjeta de débito', account_money: 'Dinero en cuenta', ticket: 'Efectivo (cupón)', bank_transfer: 'Transferencia', wire_transfer: 'Transferencia', cash: 'Efectivo', other: 'Otro' };
  const parts = [];
  if (d.method) parts.push(methods[d.method] || d.method);
  if (d.credit_card_company) parts.push(String(d.credit_card_company).toUpperCase());
  if (d.installments && Number(d.installments) > 1) parts.push(`${d.installments} cuotas`);
  return parts.join(' · ') || null;
}

function mapItems(order) {
  return (order.products || []).map((p) => {
    const local = tn.findLocalForItem(p);
    const variant = Array.isArray(p.variant_values) ? p.variant_values.map(text).filter(Boolean).join(' / ') : '';
    return {
      name: text(p.name),
      variant: variant || null,
      sku: p.sku || null,
      quantity: Number(p.quantity) || 0,
      price: num(p.price),
      subtotal: round2((Number(p.price) || 0) * (Number(p.quantity) || 0)),
      image: p.image && p.image.src ? p.image.src : null,
      tn_product_id: p.product_id ? String(p.product_id) : null,
      tn_variant_id: p.variant_id ? String(p.variant_id) : null,
      product_id: local ? local.id : null,
      product_name: local ? local.name : null,
    };
  });
}

// Guarda (o actualiza) la orden con todos sus datos.
function save(order) {
  const c = order.customer || {};
  const s = order.shipping_address || {};
  const name = order.contact_name || c.name || s.name || 'Sin nombre';
  const email = order.contact_email || c.email || null;
  const phone = order.contact_phone || c.phone || s.phone || order.billing_phone || null;
  const pickup = order.shipping_pickup_type === 'pickup';
  const ledger = db.one('SELECT status FROM tn_orders WHERE order_id = ?', String(order.id));
  const stockStatus = ledger ? ledger.status : 'not_applied';

  let clientId = null;
  try {
    clientId = agenda.upsertClient({ name, phone, email });
  } catch {
    // un cliente con datos raros no impide registrar la venta
  }

  const values = {
    number: order.number ? String(order.number) : null,
    client_id: clientId,
    status: order.status || null,
    payment_status: order.payment_status || null,
    shipping_status: order.shipping_status || null,
    customer_name: name,
    customer_email: email,
    customer_phone: phone,
    customer_dni: order.contact_identification || c.identification || null,
    shipping_name: s.name || name,
    shipping_phone: s.phone || phone,
    shipping_address: pickup ? null : formatAddress(s),
    shipping_city: pickup ? null : s.city || null,
    shipping_province: pickup ? null : s.province || null,
    shipping_zipcode: pickup ? null : s.zipcode || null,
    shipping_method: [typeof order.shipping_option === 'object' ? text(order.shipping_option && order.shipping_option.name) : order.shipping_option, order.shipping_store_branch_name].filter(Boolean).join(' - ') || (pickup ? 'Retiro en local' : null),
    shipping_pickup: pickup ? 1 : 0,
    shipping_tracking: order.shipping_tracking_number || null,
    shipping_tracking_url: order.shipping_tracking_url || null,
    gateway: order.gateway_name || order.gateway || null,
    gateway_id: order.gateway_id ? String(order.gateway_id) : null,
    payment_detail: paymentDetail(order),
    currency: order.currency || 'ARS',
    subtotal: num(order.subtotal),
    discount: num(round2((Number(order.discount) || 0) + (Number(order.discount_coupon) || 0) + (Number(order.discount_gateway) || 0))),
    shipping_cost: num(order.shipping_cost_customer),
    total: num(order.total),
    customer_note: order.note || null,
    owner_note: order.owner_note || null,
    items: JSON.stringify(mapItems(order)),
    raw: JSON.stringify(order),
    stock_status: stockStatus,
    ordered_at: toSql(order.created_at),
    paid_at: toSql(order.paid_at),
    shipped_at: toSql(order.shipped_at),
    cancelled_at: toSql(order.cancelled_at),
  };
  const cols = Object.keys(values);
  db.run(
    `INSERT INTO web_orders (tn_order_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
     ON CONFLICT(tn_order_id) DO UPDATE SET ${cols.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = datetime('now')`,
    String(order.id),
    ...cols.map((k) => values[k])
  );
  return db.one('SELECT id FROM web_orders WHERE tn_order_id = ?', String(order.id)).id;
}

/**
 * Registra una orden y mueve el stock local si corresponde.
 *  - source 'webhook': orden nueva avisada por Tienda Nube → se descuenta el stock.
 *  - source 'sync': orden traída por la sincronización → se descuenta solo si es posterior a la conexión
 *    (las órdenes viejas se importan como historial, sin tocar el stock).
 */
function processOrder(order, { source = 'webhook', cancelled = false } = {}) {
  return db.tx(() => {
    const orderedAt = toSql(order.created_at);
    if (cancelled || order.status === 'cancelled') {
      const res = tn.applyOrder(order, 'revert');
      if (!res.skipped) log('tiendanube', 'info', `Orden #${order.number || order.id} cancelada: stock repuesto`);
    } else {
      const since = settings.get('tn_orders_since');
      const isNew = source === 'webhook' || (since && orderedAt && orderedAt >= since);
      if (isNew) {
        const res = tn.applyOrder(order, 'apply');
        if (!res.skipped) log('tiendanube', 'info', `Venta web #${order.number || order.id} ($${order.total}) - stock descontado`);
      }
    }
    return save(order);
  });
}

async function handleEvent(event, orderId) {
  const order = await tn.api(`/orders/${orderId}`);
  return processOrder(order, { source: 'webhook', cancelled: event === 'order/cancelled' });
}

/**
 * Trae de Tienda Nube las órdenes nuevas o modificadas (respaldo de los webhooks).
 * La primera vez importa los últimos `days` días como historial.
 */
let syncing = false;
async function sync({ days = 30 } = {}) {
  if (!tn.isConfigured()) throw new HttpError(503, 'Tienda Nube no está conectada');
  if (syncing) return { skipped: true };
  syncing = true;
  try {
    if (!settings.get('tn_orders_since')) settings.set({ tn_orders_since: sqlNow() });
    const last = settings.get('tn_orders_last_sync');
    // Margen de 10 minutos para no perder órdenes por diferencias de reloj.
    const from = last ? new Date(Date.parse(`${last.replace(' ', 'T')}Z`) - 10 * 60e3) : new Date(Date.now() - days * 86400e3);
    const startedAt = sqlNow();
    let count = 0;
    for (let page = 1; page < 50; page++) {
      let batch;
      try {
        batch = await tn.api(`/orders?per_page=100&page=${page}&updated_at_min=${encodeURIComponent(from.toISOString())}`);
      } catch (err) {
        if (err.status === 404) break; // después de la última página
        throw err;
      }
      if (!Array.isArray(batch) || !batch.length) break;
      for (const order of batch) {
        processOrder(order, { source: 'sync' });
        count++;
      }
      if (batch.length < 100) break;
    }
    settings.set({ tn_orders_last_sync: startedAt });
    return { synced: count };
  } finally {
    syncing = false;
  }
}

function parse(row) {
  if (!row) return row;
  const { raw, ...rest } = row;
  return { ...rest, items: JSON.parse(row.items || '[]') };
}

function list({ q, payment, shipping, status, from, to, limit = 300 }) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(customer_name LIKE ? OR customer_email LIKE ? OR customer_phone LIKE ? OR number LIKE ? OR customer_dni LIKE ?)');
    params.push(...Array(5).fill(`%${q}%`));
  }
  if (payment) {
    where.push('payment_status = ?');
    params.push(payment);
  }
  if (shipping === 'pending') where.push("status != 'cancelled' AND payment_status = 'paid' AND IFNULL(shipping_status, '') NOT IN ('fulfilled', 'shipped', 'delivered')");
  else if (shipping) {
    where.push('shipping_status = ?');
    params.push(shipping);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (from) {
    where.push('ordered_at >= ?');
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push('ordered_at <= ?');
    params.push(`${to} 23:59:59`);
  }
  return db
    .all(`SELECT * FROM web_orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ordered_at DESC, id DESC LIMIT ?`, ...params, limit)
    .map(parse);
}

function get(id) {
  const row = db.one('SELECT * FROM web_orders WHERE id = ?', id);
  if (!row) throw notFound('La venta no existe');
  if (!row.seen_at) db.run(`UPDATE web_orders SET seen_at = datetime('now') WHERE id = ?`, id);
  return parse(row);
}

function stats() {
  return db.one(
    `SELECT
       SUM(CASE WHEN seen_at IS NULL THEN 1 ELSE 0 END) AS unseen,
       SUM(CASE WHEN status != 'cancelled' AND payment_status = 'paid' AND IFNULL(shipping_status, '') NOT IN ('fulfilled', 'shipped', 'delivered') THEN 1 ELSE 0 END) AS to_ship,
       SUM(CASE WHEN status != 'cancelled' AND payment_status IN ('pending', 'authorized') THEN 1 ELSE 0 END) AS unpaid
     FROM web_orders`
  );
}

/**
 * Corrobora el pago contra Mercado Pago cuando la orden se cobró con Mercado Pago en la misma cuenta.
 */
async function verifyPayment(id) {
  const row = db.one('SELECT * FROM web_orders WHERE id = ?', id);
  if (!row) throw notFound('La venta no existe');
  if (!/mercado ?pago/i.test(row.gateway || '')) {
    return { verifiable: false, message: `La orden se cobró con ${row.gateway || 'otro medio'}: verificá el pago en el panel de ese medio o de Tienda Nube.` };
  }
  if (!mp.isConfigured()) return { verifiable: false, message: 'Configurá Mercado Pago en el sistema para poder verificar los pagos.' };
  if (!row.gateway_id) return { verifiable: false, message: 'Tienda Nube no informó el número de operación de Mercado Pago.' };
  try {
    const p = await mp.getPayment(row.gateway_id);
    const amount = round2(p.transaction_amount || 0);
    return {
      verifiable: true,
      payment_id: String(p.id),
      status: p.status,
      status_detail: p.status_detail,
      amount,
      net_amount: p.transaction_details ? round2(p.transaction_details.net_received_amount || 0) : null,
      matches_total: Math.abs(amount - (row.total || 0)) < 0.01,
      date_approved: p.date_approved,
      method: [p.payment_method_id, p.installments > 1 ? `${p.installments} cuotas` : null].filter(Boolean).join(' · '),
      payer: p.payer && p.payer.email,
    };
  } catch (err) {
    if (err.status === 404) {
      return { verifiable: false, message: `La operación ${row.gateway_id} no está en la cuenta de Mercado Pago configurada (puede haberse cobrado con otra cuenta).` };
    }
    throw err;
  }
}

module.exports = { processOrder, handleEvent, sync, list, get, stats, verifyPayment, toSql };
