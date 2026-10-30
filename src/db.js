const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  duration_min INTEGER NOT NULL DEFAULT 30,
  price REAL NOT NULL DEFAULT 0,
  deposit_amount REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS business_hours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocked_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_token TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  deposit_amount REAL NOT NULL DEFAULT 0,
  deposit_paid REAL NOT NULL DEFAULT 0,
  balance_paid REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web',
  notes TEXT,
  alert TEXT,
  mp_preference_id TEXT,
  mp_payment_id TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date, status);

-- Inventario: categoría > subcategoría > artículo > variantes (cada variante es una fila de products).
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id),
  tn_category_id TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  brand TEXT,
  category_id INTEGER REFERENCES categories(id),
  attributes TEXT NOT NULL DEFAULT '[]',
  weight REAL,
  width REAL,
  height REAL,
  depth REAL,
  free_shipping INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  publish_online INTEGER NOT NULL DEFAULT 1,
  tn_product_id TEXT,
  tn_attributes TEXT,
  tn_sync_status TEXT,
  tn_sync_error TEXT,
  tn_last_sync TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS article_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  filename TEXT,
  url TEXT,
  position INTEGER NOT NULL DEFAULT 1,
  tn_image_id TEXT,
  tn_position INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Borrados pendientes de replicar en Tienda Nube (variantes, fotos, productos).
CREATE TABLE IF NOT EXISTS tn_pending_deletes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  publish_online INTEGER NOT NULL DEFAULT 1,
  tn_product_id TEXT,
  tn_variant_id TEXT,
  tn_sync_status TEXT,
  tn_sync_error TEXT,
  tn_last_sync TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_tn ON products(tn_product_id, tn_variant_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL,
  stock_after INTEGER NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  reference TEXT,
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, id);

CREATE TABLE IF NOT EXISTS cash_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  opened_by INTEGER,
  opening_amount REAL NOT NULL DEFAULT 0,
  closed_at TEXT,
  closed_by INTEGER,
  counted_amount REAL,
  expected_cash REAL,
  difference REAL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cash_session_id INTEGER REFERENCES cash_sessions(id),
  client_id INTEGER REFERENCES clients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL,
  mp_preference_id TEXT,
  mp_init_point TEXT,
  mp_payment_id TEXT,
  notes TEXT,
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  service_id INTEGER REFERENCES services(id),
  appointment_id INTEGER REFERENCES appointments(id),
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL,
  subtotal REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cash_session_id INTEGER REFERENCES cash_sessions(id),
  type TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT,
  sale_id INTEGER REFERENCES sales(id),
  appointment_id INTEGER REFERENCES appointments(id),
  reference TEXT,
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(cash_session_id);

CREATE TABLE IF NOT EXISTS mp_payments (
  payment_id TEXT PRIMARY KEY,
  status TEXT,
  external_reference TEXT,
  amount REAL,
  applied INTEGER NOT NULL DEFAULT 0,
  refunded INTEGER NOT NULL DEFAULT 0,
  raw TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tn_orders (
  order_id TEXT PRIMARY KEY,
  number TEXT,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ventas de la tienda online (Tienda Nube), con todos los datos para preparar el envío y controlar el pago.
CREATE TABLE IF NOT EXISTS web_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tn_order_id TEXT NOT NULL UNIQUE,
  number TEXT,
  client_id INTEGER REFERENCES clients(id),
  status TEXT,
  payment_status TEXT,
  shipping_status TEXT,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  customer_dni TEXT,
  shipping_name TEXT,
  shipping_phone TEXT,
  shipping_address TEXT,
  shipping_city TEXT,
  shipping_province TEXT,
  shipping_zipcode TEXT,
  shipping_method TEXT,
  shipping_pickup INTEGER NOT NULL DEFAULT 0,
  shipping_tracking TEXT,
  shipping_tracking_url TEXT,
  gateway TEXT,
  gateway_id TEXT,
  payment_detail TEXT,
  currency TEXT,
  subtotal REAL,
  discount REAL,
  shipping_cost REAL,
  total REAL,
  customer_note TEXT,
  owner_note TEXT,
  items TEXT,
  raw TEXT,
  stock_status TEXT,
  ordered_at TEXT,
  paid_at TEXT,
  shipped_at TEXT,
  cancelled_at TEXT,
  seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_web_orders_ordered ON web_orders(ordered_at);

-- Gastos del negocio (alquiler, sueldos, servicios...). Si se pagaron desde la caja quedan vinculados al movimiento.
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  payment_method TEXT,
  cash_movement_id INTEGER REFERENCES cash_movements(id),
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);

CREATE TABLE IF NOT EXISTS integration_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  integration TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let db = null;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  conn.exec(SCHEMA);
  migrate(conn);
  return conn;
}

// Columnas agregadas después de la primera versión (las bases existentes no las tienen).
const MIGRATIONS = [
  ['appointments', 'wa_status', 'TEXT'],
  ['appointments', 'wa_error', 'TEXT'],
  ['appointments', 'wa_sent_at', 'TEXT'],
  ['appointments', 'mp_checked_at', 'TEXT'],
  ['sales', 'mp_checked_at', 'TEXT'],
  ['products', 'article_id', 'INTEGER REFERENCES articles(id)'],
  ['products', 'variant_values', "TEXT NOT NULL DEFAULT '[]'"],
  ['products', 'promo_price', 'REAL'],
  ['products', 'weight', 'REAL'],
  ['products', 'width', 'REAL'],
  ['products', 'height', 'REAL'],
  ['products', 'depth', 'REAL'],
  // Costos para el informe de resultados (se guarda una "foto" del costo en cada venta/turno).
  ['products', 'cost', 'REAL'],
  ['services', 'cost', 'REAL'],
  ['sale_items', 'unit_cost', 'REAL'],
  ['appointments', 'service_cost', 'REAL'],
];

function migrate(conn) {
  for (const [table, column, type] of MIGRATIONS) {
    const cols = conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  migrateProductsToArticles(conn);
}

/**
 * Los productos de la versión anterior pasan a ser artículos. Los que venían de la misma
 * publicación de Tienda Nube ("Nombre - Variante") se agrupan como variantes de un mismo artículo.
 */
function migrateProductsToArticles(conn) {
  const orphans = conn.prepare('SELECT * FROM products WHERE article_id IS NULL ORDER BY id').all();
  if (!orphans.length) return;
  const groups = new Map();
  for (const p of orphans) {
    const key = p.tn_product_id ? `tn:${p.tn_product_id}` : `p:${p.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const insertArticle = conn.prepare(
    `INSERT INTO articles (name, description, attributes, active, publish_online, tn_product_id, tn_attributes, tn_sync_status, tn_sync_error, tn_last_sync)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateProduct = conn.prepare('UPDATE products SET article_id = ?, variant_values = ? WHERE id = ?');
  conn.exec('BEGIN');
  try {
    for (const rows of groups.values()) {
      const multi = rows.length > 1;
      const base = multi ? commonPrefix(rows.map((r) => r.name)) : rows[0].name;
      const attrs = multi ? ['Variante'] : [];
      const first = rows[0];
      const art = insertArticle.run(
        base || first.name,
        first.description,
        JSON.stringify(attrs),
        rows.some((r) => r.active) ? 1 : 0,
        first.publish_online,
        first.tn_product_id,
        first.tn_product_id ? JSON.stringify(attrs) : null,
        first.tn_sync_status,
        first.tn_sync_error,
        first.tn_last_sync
      );
      for (const r of rows) {
        const value = multi ? r.name.slice(base.length).replace(/^[\s-–/]+/, '').trim() || r.name : null;
        updateProduct.run(Number(art.lastInsertRowid), JSON.stringify(multi ? [value] : []), r.id);
      }
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

function commonPrefix(names) {
  // "Aceite - 100ml" y "Aceite - 250ml" => "Aceite"
  const parts = names.map((n) => n.split(' - '));
  const out = [];
  for (let i = 0; i < parts[0].length - 1; i++) {
    if (parts.every((p) => p[i] === parts[0][i] && p.length > i + 1)) out.push(parts[0][i]);
    else break;
  }
  return out.join(' - ');
}

let dbFile = null;

function init(file) {
  if (db) db.close();
  dbFile = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'estetica.db');
  db = open(dbFile);
  return db;
}

// Carpeta donde se guardan las fotos (junto a la base, así quedan en el volumen persistente).
function uploadsDir() {
  if (process.env.UPLOADS_DIR) return process.env.UPLOADS_DIR;
  if (!dbFile || dbFile === ':memory:') return path.join(require('node:os').tmpdir(), 'estetica-uploads');
  return path.join(path.dirname(dbFile), 'uploads');
}

function get() {
  if (!db) init();
  return db;
}

// Runs fn inside a transaction. Nested calls reuse the outer transaction.
let depth = 0;
function tx(fn) {
  const conn = get();
  if (depth > 0) return fn(conn);
  conn.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const result = fn(conn);
    depth--;
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    depth--;
    conn.exec('ROLLBACK');
    throw err;
  }
}

const all = (sql, ...params) => get().prepare(sql).all(...params);
const one = (sql, ...params) => get().prepare(sql).get(...params);
const run = (sql, ...params) => get().prepare(sql).run(...params);

module.exports = { init, get, tx, all, one, run, uploadsDir };
