const db = require('../db');
const settings = require('../settings');
const cash = require('./cash');
const { badRequest, notFound, conflict, money, isDate, nowInTz } = require('../util');

// La compra de mercadería no es un gasto: su costo se cuenta cuando el producto se vende.
const CATEGORIES = [
  'Alquiler',
  'Sueldos y honorarios',
  'Servicios (luz, agua, internet)',
  'Insumos y descartables',
  'Publicidad y marketing',
  'Comisiones (Mercado Pago, Tienda Nube)',
  'Impuestos y tasas',
  'Mantenimiento y equipamiento',
  'Envíos',
  'Otros',
];

const today = () => nowInTz(settings.get('timezone')).date;

function list({ from, to }) {
  return db.all(
    `SELECT e.*, u.username FROM expenses e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.date BETWEEN ? AND ? ORDER BY e.date DESC, e.id DESC`,
    from,
    to
  );
}

/**
 * Registra un gasto. Si se pagó con plata de la caja (fromCash), también sale de la caja abierta.
 */
function create({ date, category, description, amount, method = 'transferencia', fromCash = false }, userId = null) {
  const d = date || today();
  if (!isDate(d)) throw badRequest('Fecha inválida');
  if (!CATEGORIES.includes(category)) throw badRequest('Elegí una categoría de gasto');
  const value = money(amount);
  if (!value) throw badRequest('Ingresá el importe del gasto');
  const desc = String(description || '').trim() || null;
  if (fromCash && !cash.METHODS[method]) throw badRequest('Medio de pago inválido');
  return db.tx(() => {
    let movementId = null;
    if (fromCash) {
      if (d !== today()) throw badRequest('Un gasto pagado con la caja tiene que ser de hoy');
      movementId = cash.addMovement({ type: 'expense', method, amount: -value, description: `${category}${desc ? `: ${desc}` : ''}` }, userId);
    }
    const res = db.run(
      'INSERT INTO expenses (date, category, description, amount, payment_method, cash_movement_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      d,
      category,
      desc,
      value,
      method || null,
      movementId,
      userId
    );
    return db.one('SELECT * FROM expenses WHERE id = ?', Number(res.lastInsertRowid));
  });
}

// Egreso cargado desde la caja: queda también como gasto con su categoría.
function fromCashMovement(movementId, { category, description, amount, method }, userId) {
  const cat = CATEGORIES.includes(category) ? category : 'Otros';
  db.run(
    'INSERT INTO expenses (date, category, description, amount, payment_method, cash_movement_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    today(),
    cat,
    String(description || '').trim() || null,
    money(amount),
    method || 'efectivo',
    movementId,
    userId
  );
}

function remove(id) {
  const e = db.one('SELECT * FROM expenses WHERE id = ?', id);
  if (!e) throw notFound('El gasto no existe');
  return db.tx(() => {
    const mv = e.cash_movement_id
      ? db.one(`SELECT m.id, s.closed_at FROM cash_movements m LEFT JOIN cash_sessions s ON s.id = m.cash_session_id WHERE m.id = ?`, e.cash_movement_id)
      : null;
    if (mv && mv.closed_at) throw conflict('Este gasto salió de una caja que ya se cerró: no se puede borrar');
    db.run('DELETE FROM expenses WHERE id = ?', id);
    if (mv) db.run('DELETE FROM cash_movements WHERE id = ?', mv.id); // vuelve la plata a la caja
    return { deleted: true };
  });
}

module.exports = { CATEGORIES, list, create, fromCashMovement, remove };
