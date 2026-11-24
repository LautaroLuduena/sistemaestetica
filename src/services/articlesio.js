const ExcelJS = require('exceljs');
const db = require('../db');
const settings = require('../settings');
const inventory = require('./inventory');
const { badRequest, HttpError, round2 } = require('../util');

// Columnas de la planilla (una fila por variante). `key` es el nombre interno.
const COLUMNS = [
  { key: 'id', header: 'ID (no modificar)', width: 12 },
  { key: 'name', header: 'Nombre', width: 32 },
  { key: 'brand', header: 'Marca', width: 16 },
  { key: 'category', header: 'Categoría', width: 20 },
  { key: 'subcategory', header: 'Subcategoría', width: 20 },
  { key: 'description', header: 'Descripción', width: 40 },
  { key: 'attr1', header: 'Tipo de variante 1', width: 16 },
  { key: 'val1', header: 'Valor 1', width: 14 },
  { key: 'attr2', header: 'Tipo de variante 2', width: 16 },
  { key: 'val2', header: 'Valor 2', width: 14 },
  { key: 'attr3', header: 'Tipo de variante 3', width: 16 },
  { key: 'val3', header: 'Valor 3', width: 14 },
  { key: 'sku', header: 'SKU', width: 14 },
  { key: 'price', header: 'Precio', width: 12, money: true },
  { key: 'promo', header: 'Precio promocional', width: 14, money: true },
  { key: 'cost', header: 'Costo', width: 12, money: true },
  { key: 'stock', header: 'Stock', width: 9 },
  { key: 'minStock', header: 'Stock mínimo', width: 10 },
  { key: 'weight', header: 'Peso (kg)', width: 10 },
  { key: 'height', header: 'Alto (cm)', width: 10 },
  { key: 'width', header: 'Ancho (cm)', width: 10 },
  { key: 'depth', header: 'Profundidad (cm)', width: 12 },
  { key: 'freeShipping', header: 'Envío gratis', width: 10 },
  { key: 'publish', header: 'Publicar en tienda', width: 12 },
  { key: 'active', header: 'Activo', width: 8 },
  { key: 'photos', header: 'Fotos (links)', width: 50 },
];

const INSTRUCTIONS = [
  ['Cómo usar esta planilla'],
  [''],
  ['• Una fila por artículo. Si el artículo tiene variantes (tamaño, color…), una fila por variante repitiendo el nombre.'],
  ['• "ID (no modificar)": identifica artículos ya cargados. Dejalo vacío para los artículos nuevos.'],
  ['• Obligatorios: Nombre, Categoría y Precio. La categoría y la subcategoría se crean si no existen.'],
  ['• Variantes: completá "Tipo de variante 1" (ej. Tamaño) y "Valor 1" (ej. 100ml). Se pueden usar hasta 3 tipos.'],
  ['• Precios, costo y medidas en números (ej. 12500 o 12500,50). Peso en kg (ej. 0,25) y medidas en cm.'],
  ['• Envío gratis / Publicar en tienda / Activo: SI o NO. Para publicar en la tienda hacen falta peso, alto, ancho y profundidad.'],
  ['• Stock: si cambiás el stock de un artículo existente, queda registrado como ajuste "Importación de planilla".'],
  ['• Fotos: links (https://…) separados por coma, hasta 3. En artículos existentes se usan solo si todavía no tienen fotos.'],
  ['• Las celdas vacías de un artículo existente no cambian lo que ya está cargado. Para quitar un precio promocional escribí 0.'],
  ['• Los artículos que no estén en la planilla no se tocan.'],
];

// ---------- Exportar ----------

function exportRows() {
  const base = settings.publicUrl();
  const cats = new Map(db.all('SELECT * FROM categories').map((c) => [c.id, c]));
  const articles = db.all('SELECT id FROM articles ORDER BY name');
  const rows = [];
  for (const { id } of articles) {
    const a = inventory.getArticle(id);
    const cat = cats.get(a.category_id);
    const parent = cat && cat.parent_id ? cats.get(cat.parent_id) : null;
    const photos = a.images.map((i) => (i.filename ? `${base}/uploads/${i.filename}` : i.url)).join(', ');
    a.variants.forEach((v, idx) => {
      rows.push({
        id: a.id,
        name: a.name,
        brand: a.brand || '',
        category: parent ? parent.name : cat ? cat.name : '',
        subcategory: parent ? cat.name : '',
        description: idx === 0 ? a.description || '' : '',
        attr1: a.attributes[0] || '',
        val1: v.values[0] || '',
        attr2: a.attributes[1] || '',
        val2: v.values[1] || '',
        attr3: a.attributes[2] || '',
        val3: v.values[2] || '',
        sku: v.sku || '',
        price: v.price,
        promo: v.promo_price || null,
        cost: v.cost ?? null,
        stock: v.stock,
        minStock: v.min_stock,
        weight: v.weight || a.weight || null,
        height: a.height || null,
        width: a.width || null,
        depth: a.depth || null,
        freeShipping: a.free_shipping ? 'SI' : 'NO',
        publish: a.publish_online ? 'SI' : 'NO',
        active: a.active ? 'SI' : 'NO',
        photos: idx === 0 ? photos : '',
      });
    });
  }
  return rows;
}

async function buildWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = settings.get('business_name') || 'Sistema';
  const ws = wb.addWorksheet('Artículos', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.money ? { numFmt: '#,##0.00' } : {} }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5E6D8' } };
  ws.getColumn('id').font = { color: { argb: 'FF888888' } };
  for (const r of rows) ws.addRow(r);
  const help = wb.addWorksheet('Instrucciones');
  help.getColumn(1).width = 120;
  for (const line of INSTRUCTIONS) help.addRow(line);
  help.getRow(1).font = { bold: true, size: 13 };
  return wb.xlsx.writeBuffer();
}

const exportXlsx = () => buildWorkbook(exportRows());

const templateXlsx = () =>
  buildWorkbook([
    { name: 'Crema post solar', brand: 'Sol Glow', category: 'Cuidado corporal', subcategory: 'Post solar', description: 'Hidrata y prolonga el bronceado.', sku: 'CR-200', price: 12000, cost: 5000, stock: 10, minStock: 2, weight: 0.25, height: 15, width: 6, depth: 6, freeShipping: 'NO', publish: 'SI', active: 'SI', photos: 'https://ejemplo.com/foto-crema.jpg' },
    { name: 'Aceite bronceador', brand: 'Tropical', category: 'Bronceado', attr1: 'Tamaño', val1: '100ml', sku: 'AC-100', price: 6000, cost: 2500, stock: 8, minStock: 2, weight: 0.15, height: 12, width: 5, depth: 5, freeShipping: 'NO', publish: 'SI', active: 'SI' },
    { name: 'Aceite bronceador', brand: 'Tropical', category: 'Bronceado', attr1: 'Tamaño', val1: '250ml', sku: 'AC-250', price: 11000, promo: 9900, cost: 4500, stock: 5, minStock: 2, weight: 0.3, height: 16, width: 6, depth: 6, freeShipping: 'NO', publish: 'SI', active: 'SI' },
  ]);

// ---------- Importar ----------

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

const HEADER_MAP = new Map(COLUMNS.map((c) => [norm(c.header), c.key]));
// Algunos nombres alternativos habituales.
for (const [alias, key] of [
  ['id', 'id'],
  ['nombre', 'name'],
  ['precio', 'price'],
  ['preciopromocional', 'promo'],
  ['promocion', 'promo'],
  ['costo', 'cost'],
  ['stock', 'stock'],
  ['peso', 'weight'],
  ['alto', 'height'],
  ['ancho', 'width'],
  ['profundidad', 'depth'],
  ['largo', 'depth'],
  ['fotos', 'photos'],
  ['publicar', 'publish'],
  ['codigo', 'sku'],
]) {
  if (!HEADER_MAP.has(alias)) HEADER_MAP.set(alias, key);
}

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v.hyperlink) return String(v.hyperlink);
  }
  return String(v).trim();
}

// Números con formato argentino ("12.500,50") o con punto decimal ("12500.5").
function parseNumber(v, field, row) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  let s = cellText(v).replace(/[$\s]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new RowError(row, `${field}: "${cellText(v)}" no es un número válido`);
  return n;
}

function parseBool(v, field, row) {
  const s = norm(cellText(v));
  if (!s) return null;
  if (['si', 's', 'yes', 'true', '1', 'x'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  throw new RowError(row, `${field}: escribí SI o NO`);
}

class RowError extends Error {
  constructor(row, message) {
    super(message);
    this.row = row;
  }
}

async function readRows(buffer, filename) {
  const wb = new ExcelJS.Workbook();
  const isCsv = /\.csv$/i.test(filename || '');
  let ws;
  try {
    if (isCsv) {
      // Excel en español guarda los CSV con ";" como separador.
      const text = buffer.toString('utf8').replace(/^﻿/, '');
      const firstLine = text.split(/\r?\n/)[0] || '';
      const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
      const { Readable } = require('node:stream');
      ws = await wb.csv.read(Readable.from([text]), { parserOptions: { delimiter }, map: (v) => v });
    } else {
      await wb.xlsx.load(buffer);
      ws = wb.getWorksheet('Artículos') || wb.worksheets[0];
    }
  } catch {
    throw badRequest('No se pudo leer el archivo. Usá la planilla exportada desde el sistema (.xlsx) o un .csv.');
  }
  if (!ws) throw badRequest('La planilla está vacía');
  const headerRow = ws.getRow(1);
  const colKeys = {};
  headerRow.eachCell((cell, col) => {
    const key = HEADER_MAP.get(norm(cellText(cell.value)));
    if (key) colKeys[col] = key;
  });
  const present = new Set(Object.values(colKeys));
  for (const required of ['name', 'price']) {
    if (!present.has(required)) throw badRequest(`Falta la columna "${COLUMNS.find((c) => c.key === required).header}" en la primera fila`);
  }
  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const r = { _row: rowNumber };
    let empty = true;
    for (const [col, key] of Object.entries(colKeys)) {
      const v = row.getCell(Number(col)).value;
      r[key] = v && typeof v === 'object' && !(v instanceof Date) ? cellText(v) : v;
      if (cellText(v) !== '') empty = false;
    }
    if (!empty) rows.push(r);
  });
  return { rows, present };
}

function findOrCreateCategory(name, subName) {
  const clean = (s) => String(s || '').trim();
  const catName = clean(name);
  if (!catName) return null;
  let cat = db.one('SELECT * FROM categories WHERE LOWER(name) = LOWER(?) AND parent_id IS NULL', catName);
  if (!cat) cat = inventory.saveCategory({ name: catName });
  const sub = clean(subName);
  if (!sub) return cat.id;
  let child = db.one('SELECT * FROM categories WHERE LOWER(name) = LOWER(?) AND parent_id = ?', sub, cat.id);
  if (!child) child = inventory.saveCategory({ name: sub, parentId: cat.id });
  return child.id;
}

/**
 * Importa artículos desde una planilla. Con dryRun, valida todo y devuelve el resumen sin guardar nada.
 */
async function importFile(buffer, filename, { dryRun = false, userId = null } = {}) {
  const { rows, present } = await readRows(buffer, filename);
  if (!rows.length) throw badRequest('La planilla no tiene artículos');
  if (rows.length > 5000) throw badRequest('La planilla tiene demasiadas filas (máximo 5000)');

  // Agrupar filas por artículo: por ID, o por nombre + marca.
  const groups = new Map();
  for (const r of rows) {
    const id = Number(cellText(r.id)) || null;
    const key = id ? `id:${id}` : `n:${norm(r.name)}|${norm(r.brand)}`;
    if (!groups.has(key)) groups.set(key, { id, rows: [] });
    groups.get(key).rows.push(r);
  }

  const result = { articles: groups.size, created: 0, updated: 0, variants: 0, errors: [], dryRun };
  const has = (k) => present.has(k);

  const run = () => {
    for (const g of groups.values()) {
      const first = g.rows[0];
      const rowNums = g.rows.map((r) => r._row);
      try {
        const name = cellText(first.name);
        if (!name) throw new RowError(first._row, 'Falta el nombre');
        // Artículo existente: por ID, por SKU o por nombre exacto.
        let existing = g.id ? db.one('SELECT id FROM articles WHERE id = ?', g.id) : null;
        if (g.id && !existing) throw new RowError(first._row, `No existe un artículo con ID ${g.id} (dejá el ID vacío para crearlo)`);
        if (!existing) {
          for (const r of g.rows) {
            const sku = cellText(r.sku);
            const p = sku ? db.one('SELECT article_id FROM products WHERE LOWER(sku) = LOWER(?) AND article_id IS NOT NULL', sku) : null;
            if (p) {
              existing = { id: p.article_id };
              break;
            }
          }
        }
        if (!existing) {
          const byName = db.all('SELECT id FROM articles WHERE LOWER(name) = LOWER(?)', name);
          if (byName.length === 1) existing = byName[0];
        }
        const current = existing ? inventory.getArticle(existing.id) : null;

        const attributes = [first.attr1, first.attr2, first.attr3].map(cellText).filter(Boolean);
        const sheetAttrs = attributes.length ? attributes : current && !has('attr1') ? current.attributes : attributes;

        const categoryId = cellText(first.category)
          ? findOrCreateCategory(first.category, first.subcategory)
          : current
            ? current.category_id
            : null;
        if (!categoryId) throw new RowError(first._row, 'Falta la categoría');

        const pick = (key, parse, fallback) => {
          const raw = first[key];
          const v = parse(raw);
          return v === null || v === undefined || v === '' ? fallback : v;
        };
        const num = (field) => (v) => parseNumber(v, field, first._row);
        const bool = (field) => (v) => parseBool(v, field, first._row);
        const text = (v) => cellText(v) || null;

        const weight = pick('weight', num('Peso'), current ? current.weight : null);
        const height = pick('height', num('Alto'), current ? current.height : null);
        const width = pick('width', num('Ancho'), current ? current.width : null);
        const depth = pick('depth', num('Profundidad'), current ? current.depth : null);
        const sizesOk = Boolean(weight && height && width && depth);
        const publishOnline = pick('publish', bool('Publicar en tienda'), current ? Boolean(current.publish_online) : sizesOk);

        // Variantes: las de la planilla (actualizan o se agregan) + las existentes que no aparecen.
        const usedIds = new Set();
        const variants = g.rows.map((r) => {
          const values = sheetAttrs.map((_, k) => cellText(r[`val${k + 1}`]));
          const sku = cellText(r.sku) || null;
          const key = values.join('|').toLowerCase();
          const match = current
            ? current.variants.find((v) => !usedIds.has(v.id) && ((sku && v.sku && v.sku.toLowerCase() === sku.toLowerCase()) || (!sku && v.values.join('|').toLowerCase() === key)))
            : null;
          if (match) usedIds.add(match.id);
          const n = (field, k, fallback) => {
            const v = parseNumber(r[k], field, r._row);
            return v === null ? fallback : v;
          };
          const price = n('Precio', 'price', match ? match.price : null);
          if (!price) throw new RowError(r._row, 'Falta el precio');
          const stockVal = n('Stock', 'stock', match ? match.stock : 0);
          if (!Number.isInteger(stockVal)) throw new RowError(r._row, 'El stock tiene que ser un número entero');
          return {
            id: match ? match.id : undefined,
            values,
            sku: sku ?? (match ? match.sku : null),
            price: round2(price),
            // Vacío = se mantiene lo cargado. Para quitar una promoción se escribe 0.
            promo_price: n('Precio promocional', 'promo', match ? match.promo_price : null),
            cost: n('Costo', 'cost', match ? match.cost : null),
            stock: stockVal,
            weight: n('Peso', 'weight', match ? match.weight : null),
          };
        });
        if (current) {
          for (const v of current.variants.filter((x) => !usedIds.has(x.id))) {
            variants.push({ id: v.id, values: v.values, sku: v.sku, price: v.price, promo_price: v.promo_price, cost: v.cost, stock: v.stock, weight: v.weight });
          }
        }

        // Fotos: las existentes se mantienen; los links de la planilla se usan si no hay fotos.
        let images = current ? current.images.map((i) => ({ id: i.id })) : [];
        if (!images.length) {
          const links = g.rows
            .flatMap((r) => cellText(r.photos).split(/[,\s]+/))
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(0, 3);
          images = links.map((url) => ({ url }));
        }

        const input = {
          name,
          brand: pick('brand', text, current ? current.brand : null),
          categoryId,
          description: pick('description', text, current ? current.description : null),
          attributes: sheetAttrs,
          variants,
          images,
          weight,
          height,
          width,
          depth,
          minStock: pick('minStock', num('Stock mínimo'), current && current.variants[0] ? current.variants[0].min_stock : 0),
          freeShipping: pick('freeShipping', bool('Envío gratis'), current ? Boolean(current.free_shipping) : false),
          publishOnline,
          active: pick('active', bool('Activo'), current ? Boolean(current.active) : true),
        };
        db.tx(() =>
          inventory.saveArticle(input, { id: current ? current.id : null, userId, requireImages: false, stockReason: 'Importación de planilla' })
        );
        if (current) result.updated++;
        else result.created++;
        result.variants += g.rows.length;
      } catch (err) {
        if (!(err instanceof RowError) && !(err instanceof HttpError)) throw err;
        result.errors.push({ rows: rowNums, name: cellText(first.name) || '(sin nombre)', message: err.message });
      }
    }
  };

  const ROLLBACK = Symbol('dry-run');
  if (dryRun) inventory.setMuted(true);
  try {
    db.tx(() => {
      run();
      if (dryRun) throw ROLLBACK; // vista previa: se deshace todo
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  } finally {
    if (dryRun) inventory.setMuted(false);
  }
  return result;
}

module.exports = { exportXlsx, templateXlsx, importFile, COLUMNS };
