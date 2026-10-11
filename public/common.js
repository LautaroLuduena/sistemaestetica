// Utilidades compartidas entre la página de reservas y el panel.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmtMoney = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(Number(n) || 0);

function fmtDate(iso, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  if (!iso) return '';
  const s = new Date(`${iso}T12:00:00`).toLocaleDateString('es-AR', opts);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtDateTime(sqlUtc) {
  if (!sqlUtc) return '';
  const d = new Date(`${String(sqlUtc).replace(' ', 'T')}Z`);
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, type = '') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = type;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), type === 'error' ? 5000 : 2800);
}

const STATUS_LABELS = {
  pending_payment: ['Esperando seña', 'warn'],
  confirmed: ['Confirmado', 'ok'],
  completed: ['Atendido', 'info'],
  cancelled: ['Cancelado', 'gray'],
  expired: ['Vencido', 'danger'],
  no_show: ['No vino', 'danger'],
};
const statusBadge = (s) => {
  const [label, cls] = STATUS_LABELS[s] || [s, 'gray'];
  return `<span class="badge ${cls}">${label}</span>`;
};
