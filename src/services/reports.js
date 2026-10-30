const db = require('../db');
const settings = require('../settings');
const { badRequest, round2, isDate, addDays, utcRange, localDateOf } = require('../util');

/**
 * Informe de resultados del negocio para un período (fechas locales, inclusive).
 *
 * Criterio: los ingresos se cuentan cuando se cobran (ventas cobradas, señas, ventas web pagadas).
 *  - Servicios: señas + saldos cobrados + servicios vendidos en caja. Su costo (insumos) se cuenta
 *    por cada turno atendido en el período, con el costo que tenía el servicio en ese momento.
 *  - Productos: precio cobrado (con descuentos) menos el costo del producto al momento de la venta.
 *  - Gastos: los cargados en Gastos y los egresos de caja.
 */
function build(from, to, { compare = true } = {}) {
  if (!isDate(from) || !isDate(to) || from > to) throw badRequest('Período inválido');
  const tz = settings.get('timezone');
  const [start, end] = utcRange(from, to, tz);
  const lines = []; // { date, channel, key, name, revenue, cost, units, missingCost }
  const expenseLines = []; // { date, category, amount }

  // A. Ventas cobradas en la caja (el descuento de la venta se reparte entre sus ítems).
  const saleRows = db.all(
    `SELECT si.*, s.subtotal AS s_subtotal, s.discount AS s_discount, s.paid_at,
            p.cost AS p_cost, p.name AS p_name, sv.cost AS sv_cost, sv.name AS sv_name,
            ap.service_id AS ap_service_id, aps.name AS ap_service_name
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     LEFT JOIN products p ON p.id = si.product_id
     LEFT JOIN services sv ON sv.id = si.service_id
     LEFT JOIN appointments ap ON ap.id = si.appointment_id
     LEFT JOIN services aps ON aps.id = ap.service_id
     WHERE s.status = 'paid' AND s.paid_at BETWEEN ? AND ?`,
    start,
    end
  );
  const saleIds = new Set();
  let ticketRevenue = 0; // lo cobrado en ventas de caja y ventas web (para el ticket promedio)
  for (const r of saleRows) {
    saleIds.add(r.sale_id);
    const factor = r.s_subtotal > 0 ? 1 - r.s_discount / r.s_subtotal : 1;
    const revenue = round2(r.subtotal * factor);
    ticketRevenue += revenue;
    const date = localDateOf(r.paid_at, tz);
    if (r.product_id) {
      const unitCost = r.unit_cost ?? r.p_cost;
      lines.push({ date, channel: 'local_products', key: `p:${r.product_id}`, name: r.p_name || r.description, revenue, cost: unitCost === null ? 0 : unitCost * r.quantity, units: r.quantity, missingCost: unitCost === null });
    } else if (r.appointment_id) {
      // Saldo de un turno: el costo se cuenta con el turno atendido (punto C).
      lines.push({ date, channel: 'services', key: `s:${r.ap_service_id}`, name: r.ap_service_name, revenue, cost: 0, units: 0, missingCost: false });
    } else if (r.service_id) {
      const unitCost = r.unit_cost ?? r.sv_cost;
      lines.push({ date, channel: 'services', key: `s:${r.service_id}`, name: r.sv_name || r.description, revenue, cost: unitCost === null ? 0 : unitCost * r.quantity, units: r.quantity, missingCost: unitCost === null });
    } else {
      lines.push({ date, channel: 'other', key: 'other', name: 'Otros conceptos', revenue, cost: 0, units: r.quantity, missingCost: false });
    }
  }

  // B. Señas cobradas (online o en el local) y devoluciones de señas.
  const deposits = db.all(
    `SELECT m.amount, m.created_at, ap.service_id, ap.date AS appt_date, s.name
     FROM cash_movements m JOIN appointments ap ON ap.id = m.appointment_id JOIN services s ON s.id = ap.service_id
     WHERE m.type IN ('deposit', 'refund') AND m.created_at BETWEEN ? AND ?`,
    start,
    end
  );
  let advanceDeposits = 0;
  for (const d of deposits) {
    lines.push({ date: localDateOf(d.created_at, tz), channel: 'services', key: `s:${d.service_id}`, name: d.name, revenue: round2(d.amount), cost: 0, units: 0, missingCost: false });
    if (d.amount > 0 && d.appt_date > to) advanceDeposits += d.amount;
  }

  // C. Turnos atendidos: una sesión por turno, con el costo de insumos del servicio.
  const attended = db.all(
    `SELECT ap.date, ap.service_id, s.name, COALESCE(ap.service_cost, s.cost) AS cost
     FROM appointments ap JOIN services s ON s.id = ap.service_id
     WHERE ap.status = 'completed' AND ap.date BETWEEN ? AND ?`,
    from,
    to
  );
  for (const a of attended) {
    lines.push({ date: a.date, channel: 'services', key: `s:${a.service_id}`, name: a.name, revenue: 0, cost: a.cost ?? 0, units: 1, missingCost: a.cost === null });
  }

  // D. Ventas de la tienda online pagadas (el envío cobrado no se cuenta como ingreso).
  const orders = db.all(
    `SELECT * FROM web_orders WHERE payment_status = 'paid' AND IFNULL(status, '') != 'cancelled'
       AND COALESCE(paid_at, ordered_at) BETWEEN ? AND ?`,
    start,
    end
  );
  const productCost = new Map(db.all('SELECT id, cost FROM products').map((p) => [p.id, p.cost]));
  let shippingCharged = 0;
  for (const o of orders) {
    const items = JSON.parse(o.items || '[]');
    const subtotal = items.reduce((t, i) => t + (i.subtotal || 0), 0);
    const factor = subtotal > 0 ? Math.max(0, 1 - (o.discount || 0) / subtotal) : 1;
    const date = localDateOf(o.paid_at || o.ordered_at, tz);
    shippingCharged += o.shipping_cost || 0;
    ticketRevenue += round2(subtotal * factor);
    for (const i of items) {
      const unitCost = i.unit_cost ?? (i.product_id ? productCost.get(i.product_id) ?? null : null);
      lines.push({
        date,
        channel: 'web_products',
        key: i.product_id ? `p:${i.product_id}` : `w:${i.name}${i.variant ? ` (${i.variant})` : ''}`,
        name: i.product_name || `${i.name}${i.variant ? ` - ${i.variant}` : ''}`,
        revenue: round2((i.subtotal || 0) * factor),
        cost: unitCost === null ? 0 : unitCost * (i.quantity || 0),
        units: i.quantity || 0,
        missingCost: unitCost === null,
      });
    }
  }

  // E. Gastos.
  for (const e of db.all('SELECT date, category, amount FROM expenses WHERE date BETWEEN ? AND ?', from, to)) {
    expenseLines.push(e);
  }
  for (const m of db.all(
    `SELECT m.amount, m.created_at FROM cash_movements m
     WHERE m.type = 'expense' AND m.created_at BETWEEN ? AND ? AND IFNULL(m.reference, '') != 'retiro'
       AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.cash_movement_id = m.id)`,
    start,
    end
  )) {
    expenseLines.push({ date: localDateOf(m.created_at, tz), category: 'Egresos de caja sin categoría', amount: -m.amount });
  }

  // ---- Agregados ----
  const sum = (arr, f) => round2(arr.reduce((t, x) => t + f(x), 0));
  const margin = (gross, revenue) => (revenue > 0 ? Math.round((gross / revenue) * 1000) / 10 : null);
  const revenue = sum(lines, (l) => l.revenue);
  const cost = sum(lines, (l) => l.cost);
  const expenses = sum(expenseLines, (e) => e.amount);
  const totals = {
    revenue,
    cost,
    gross: round2(revenue - cost),
    expenses,
    net: round2(revenue - cost - expenses),
  };
  totals.grossMargin = margin(totals.gross, revenue);
  totals.netMargin = margin(totals.net, revenue);
  if (!compare) return { totals };

  const CHANNELS = { services: 'Servicios (turnos)', local_products: 'Productos en el local', web_products: 'Productos en la tienda online', other: 'Otros conceptos' };
  const channels = Object.entries(CHANNELS).map(([key, label]) => {
    const ls = lines.filter((l) => l.channel === key);
    const r = sum(ls, (l) => l.revenue);
    const c = sum(ls, (l) => l.cost);
    return { key, label, revenue: r, cost: c, gross: round2(r - c), margin: margin(r - c, r), units: ls.reduce((t, l) => t + l.units, 0) };
  });

  const group = (filter, extra = () => ({})) => {
    const map = new Map();
    for (const l of lines.filter(filter)) {
      const g = map.get(l.key) || { key: l.key, name: l.name, units: 0, revenue: 0, cost: 0, missingCost: false, ...extra() };
      g.units += l.units;
      g.revenue += l.revenue;
      g.cost += l.cost;
      g.missingCost = g.missingCost || l.missingCost;
      if (l.channel === 'local_products') g.localUnits = (g.localUnits || 0) + l.units;
      if (l.channel === 'web_products') g.webUnits = (g.webUnits || 0) + l.units;
      map.set(l.key, g);
    }
    return [...map.values()]
      .map((g) => ({ ...g, revenue: round2(g.revenue), cost: round2(g.cost), gross: round2(g.revenue - g.cost), margin: margin(g.revenue - g.cost, g.revenue) }))
      .sort((x, y) => y.gross - x.gross);
  };
  const services = group((l) => l.channel === 'services');
  const products = group((l) => l.channel === 'local_products' || l.channel === 'web_products');

  const byCategory = new Map();
  for (const e of expenseLines) byCategory.set(e.category, (byCategory.get(e.category) || 0) + e.amount);
  const expensesByCategory = [...byCategory.entries()].map(([category, amount]) => ({ category, amount: round2(amount) })).sort((x, y) => y.amount - x.amount);

  // Serie temporal: por día (hasta 62 días) o por mes.
  const days = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400e3) + 1;
  const byMonth = days > 62;
  const bucketOf = (d) => (byMonth ? d.slice(0, 7) : d);
  const buckets = new Map();
  if (byMonth) {
    for (let d = from; d <= to; d = addDays(d, 28)) buckets.set(d.slice(0, 7), { revenue: 0, cost: 0, expenses: 0 });
    buckets.set(to.slice(0, 7), { revenue: 0, cost: 0, expenses: 0 });
  } else {
    for (let d = from; d <= to; d = addDays(d, 1)) buckets.set(d, { revenue: 0, cost: 0, expenses: 0 });
  }
  for (const l of lines) {
    const b = buckets.get(bucketOf(l.date));
    if (b) {
      b.revenue += l.revenue;
      b.cost += l.cost;
    }
  }
  for (const e of expenseLines) {
    const b = buckets.get(bucketOf(e.date));
    if (b) b.expenses += e.amount;
  }
  const series = [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, b]) => ({ key, revenue: round2(b.revenue), gross: round2(b.revenue - b.cost), net: round2(b.revenue - b.cost - b.expenses) }));

  // Período anterior de igual duración, para comparar.
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  const previous = build(prevFrom, prevTo, { compare: false }).totals;

  const salesCount = saleIds.size + orders.length;
  return {
    from,
    to,
    groupBy: byMonth ? 'month' : 'day',
    totals,
    previous: { from: prevFrom, to: prevTo, ...previous },
    channels,
    services,
    products,
    expensesByCategory,
    series,
    extra: {
      appointmentsAttended: attended.length,
      salesCount,
      webOrders: orders.length,
      avgTicket: salesCount ? round2(ticketRevenue / salesCount) : 0,
      advanceDeposits: round2(advanceDeposits),
      shippingCharged: round2(shippingCharged),
      productsWithoutCost: products.filter((p) => p.missingCost).length,
      servicesWithoutCost: services.filter((s) => s.missingCost).length,
    },
  };
}

module.exports = { build };
