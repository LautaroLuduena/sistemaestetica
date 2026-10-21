/* Panel de administración (SPA sin dependencias). */

const METHOD_LABELS = { efectivo: 'Efectivo', mercadopago: 'Mercado Pago', debito: 'Débito', credito: 'Crédito', transferencia: 'Transferencia' };
const CASH_TYPES = { sale: 'Venta', deposit: 'Seña', income: 'Ingreso', expense: 'Egreso', refund: 'Devolución', sale_cancel: 'Anulación' };
const STOCK_TYPES = {
  initial: 'Stock inicial',
  adjustment: 'Ajuste',
  sale: 'Venta en local',
  sale_cancel: 'Anulación de venta',
  tiendanube_order: 'Venta Tienda Nube',
  tiendanube_cancel: 'Cancelación Tienda Nube',
  tiendanube_import: 'Importado de Tienda Nube',
};
const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- Infra: sesión, router, modales ----------

const app = { user: null, view: null, cart: [], services: [] };

async function adminApi(path, opts) {
  try {
    return await api(path, opts);
  } catch (err) {
    if (err.status === 401 && !path.startsWith('/api/auth/')) showLogin();
    throw err;
  }
}

// Ejecuta una acción mostrando el error como toast.
async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  }
}

function showLogin() {
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    await api('/api/auth/login', { method: 'POST', body });
    $('#login-error').classList.add('hidden');
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').classList.remove('hidden');
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  showLogin();
});

async function start() {
  try {
    const me = await api('/api/auth/me');
    app.user = me.user;
    $('#brand').textContent = me.business_name || 'Estética';
    $('#user-name').textContent = me.user.name || me.user.username;
  } catch {
    showLogin();
    return;
  }
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  const err = new URLSearchParams(location.search).get('error');
  if (err) {
    toast(err, 'error');
    history.replaceState(null, '', location.pathname + location.hash);
  }
  route();
}

const VIEWS = {};
function route() {
  const [name, query] = (location.hash.slice(1) || 'inicio').split('?');
  const view = VIEWS[name] ? name : 'inicio';
  app.view = view;
  app.query = new URLSearchParams(query || '');
  $$('.sidebar a[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  $('#main').innerHTML = '<p class="muted">Cargando…</p>';
  VIEWS[view]().catch((err) => {
    $('#main').innerHTML = `<div class="alert danger">${esc(err.message)}</div>`;
  });
}
window.addEventListener('hashchange', () => {
  $$('.modal-bg').forEach((m) => m.remove());
  route();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal-bg').at(-1)?.remove();
});

function modal(html, { wide = false } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${html}</div>`;
  bg.addEventListener('mousedown', (e) => {
    if (e.target === bg) bg.remove();
  });
  document.body.appendChild(bg);
  $$('[data-close]', bg).forEach((b) => b.addEventListener('click', () => bg.remove()));
  const first = $('input:not([type=hidden]), select, textarea', bg);
  if (first) first.focus();
  return bg;
}

const formData = (form) => Object.fromEntries(new FormData(form));
const methodOptions = (sel = 'efectivo') =>
  Object.entries(METHOD_LABELS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');

async function loadServices() {
  app.services = await adminApi('/api/admin/services');
  return app.services;
}

// ---------- Inicio ----------

VIEWS.inicio = async () => {
  const d = await adminApi('/api/admin/dashboard');
  const c = d.cash;
  $('#main').innerHTML = `
    <div class="page-head"><h1>Hoy, ${fmtDate(d.today)}</h1>
      <div class="row"><a class="btn" href="#agenda">Nuevo turno</a><a class="btn secondary" href="#caja">Ir a la caja</a></div></div>
    ${!d.integrations.mercadopago ? '<div class="alert warn">Mercado Pago no está configurado: las clientas no van a poder pagar la seña online. <a href="#config?tab=mp">Configurar</a></div>' : ''}
    ${d.tnSyncErrors ? `<div class="alert warn">${d.tnSyncErrors} producto(s) con error de sincronización con Tienda Nube. <a href="#config?tab=tn">Ver</a></div>` : ''}
    ${d.alerts.map((a) => `<div class="alert danger"><b>Turno ${fmtDate(a.date, { day: '2-digit', month: '2-digit' })} ${a.start_time} - ${esc(a.client_name)}:</b> ${esc(a.alert)} <button class="link" data-appt="${a.id}">Ver</button></div>`).join('')}
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Turnos hoy</div><div class="value">${d.appointments.length}</div></div>
      <div class="card stat"><div class="label">Caja</div><div class="value">${c ? fmtMoney(c.total) : '<span class="badge gray">Cerrada</span>'}</div></div>
      <div class="card stat"><div class="label">Efectivo esperado</div><div class="value">${c ? fmtMoney(c.expectedCash) : '-'}</div></div>
      <div class="card stat"><div class="label">Productos con poco stock</div><div class="value">${d.lowStock.length}</div></div>
    </div>
    ${d.integrations.tiendanube && d.webOrders && d.webOrders.to_ship ? `<div class="alert info"><b>${d.webOrders.to_ship} venta(s) web pagada(s) para preparar y enviar.</b> <a href="#ventasweb?shipping=pending">Ver ventas web</a></div>` : ''}
    <div class="grid cols-2">
      <div class="card"><h2>Turnos de hoy</h2>${apptList(d.appointments) || '<p class="muted">No hay turnos para hoy.</p>'}</div>
      <div class="card"><h2>Stock bajo</h2>${
        d.lowStock.length
          ? `<table><tr><th>Producto</th><th class="num">Stock</th><th class="num">Mínimo</th></tr>${d.lowStock
              .map((p) => `<tr><td>${esc(p.name)}</td><td class="num"><span class="badge ${p.stock <= 0 ? 'danger' : 'warn'}">${p.stock}</span></td><td class="num">${p.min_stock}</td></tr>`)
              .join('')}</table>`
          : '<p class="muted">Todo en orden.</p>'
      }</div>
    </div>`;
  bindApptClicks();
  updateWebBadge(d.webOrders);
};

function updateWebBadge(stats) {
  const el = $('#web-badge');
  if (!el || !stats) return;
  el.textContent = stats.unseen || '';
  el.classList.toggle('hidden', !stats.unseen);
}

function apptList(list) {
  return list
    .map(
      (a) => `<div class="appt" data-appt="${a.id}">
        <div class="time">${a.start_time}<br><small class="muted">${a.end_time}</small></div>
        <div><b>${esc(a.client_name)}</b> <small class="muted">${esc(a.client_phone || '')}</small><br>
          <small>${esc(a.service_name)}${a.deposit_paid ? ` · seña ${fmtMoney(a.deposit_paid)}` : ''}${a.balance ? ` · saldo ${fmtMoney(a.balance)}` : ''}</small>
          ${a.alert ? '<br><span class="badge danger">Revisar</span>' : ''}</div>
        <div>${statusBadge(a.status)}${a.source === 'web' ? ' <span class="badge gray">web</span>' : ''}</div>
      </div>`
    )
    .join('');
}

function waBadge(a) {
  if (a.wa_status === 'sent') return `<span class="badge ok">WhatsApp enviado ${fmtDateTime(a.wa_sent_at)}</span>`;
  if (a.wa_status === 'error') return `<span class="badge danger" title="${esc(a.wa_error || '')}">WhatsApp no enviado</span> <small class="muted">${esc(a.wa_error || '')}</small>`;
  return '';
}

function bindApptClicks(root = document) {
  $$('[data-appt]', root).forEach((el) => el.addEventListener('click', () => openAppointment(Number(el.dataset.appt))));
}

// ---------- Agenda ----------

app.agenda = { from: today(), days: 7, status: '', q: '' };

VIEWS.agenda = async () => {
  await loadServices();
  const s = app.agenda;
  const to = addDays(s.from, s.days - 1);
  const list = await adminApi(`/api/admin/appointments?from=${s.from}&to=${to}&status=${s.status}&q=${encodeURIComponent(s.q)}`);
  const byDay = {};
  for (let i = 0; i < s.days; i++) byDay[addDays(s.from, i)] = [];
  for (const a of list) (byDay[a.date] ||= []).push(a);
  const hideInactive = !s.status;

  $('#main').innerHTML = `
    <div class="page-head"><h1>Agenda</h1><button id="new-appt">+ Nuevo turno</button></div>
    <div class="card row">
      <button class="secondary small" id="prev">◀</button>
      <input type="date" id="from" value="${s.from}" style="width:auto" />
      <button class="secondary small" id="next">▶</button>
      <button class="secondary small" id="today">Hoy</button>
      <select id="days" style="width:auto">
        <option value="1" ${s.days === 1 ? 'selected' : ''}>1 día</option>
        <option value="7" ${s.days === 7 ? 'selected' : ''}>7 días</option>
        <option value="30" ${s.days === 30 ? 'selected' : ''}>30 días</option>
      </select>
      <select id="status" style="width:auto">
        <option value="">Activos</option>
        ${Object.entries(STATUS_LABELS).map(([k, [l]]) => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <input id="q" placeholder="Buscar clienta o teléfono" value="${esc(s.q)}" class="grow" style="min-width:160px" />
    </div>
    <div class="card">
      ${Object.entries(byDay)
        .map(([day, items]) => {
          const shown = hideInactive ? items.filter((a) => !['cancelled', 'expired'].includes(a.status) || a.alert) : items;
          return `<div class="agenda-day"><h3>${fmtDate(day)} <small class="muted">(${shown.length})</small></h3>
            ${apptList(shown) || '<p class="muted">Sin turnos</p>'}</div>`;
        })
        .join('')}
    </div>`;

  const reload = () => VIEWS.agenda();
  $('#prev').onclick = () => ((s.from = addDays(s.from, -s.days)), reload());
  $('#next').onclick = () => ((s.from = addDays(s.from, s.days)), reload());
  $('#today').onclick = () => ((s.from = today()), reload());
  $('#from').onchange = (e) => ((s.from = e.target.value || today()), reload());
  $('#days').onchange = (e) => ((s.days = Number(e.target.value)), reload());
  $('#status').onchange = (e) => ((s.status = e.target.value), reload());
  let t;
  $('#q').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      s.q = e.target.value;
      reload().then(() => {
        const q = $('#q');
        q.focus();
        q.setSelectionRange(q.value.length, q.value.length);
      });
    }, 400);
  };
  $('#new-appt').onclick = () => newAppointmentModal();
  bindApptClicks($('#main'));
};

function newAppointmentModal(prefill = {}) {
  const services = app.services.filter((x) => x.active);
  const m = modal(`
    <h2>Nuevo turno</h2>
    <form id="f">
      <label>Servicio<select name="serviceId" required>${services.map((x) => `<option value="${x.id}">${esc(x.name)} (${x.duration_min} min - ${fmtMoney(x.price)})</option>`).join('')}</select></label>
      <div class="grid cols-2">
        <label>Fecha<input type="date" name="date" required value="${prefill.date || app.agenda.from}" /></label>
        <label>Hora<input type="time" name="time" required step="300" /></label>
      </div>
      <div id="slot-hint" class="muted" style="margin:-0.4em 0 0.8em;font-size:0.85rem"></div>
      <div class="grid cols-2">
        <label>Nombre<input name="name" required /></label>
        <label>Teléfono<input name="phone" type="tel" /></label>
      </div>
      <label>Email<input name="email" type="email" /></label>
      <div class="grid cols-2">
        <label>Precio<input name="price" type="number" step="0.01" min="0" /></label>
        <label>Seña a cobrar<input name="depositAmount" type="number" step="0.01" min="0" /></label>
      </div>
      <label>Notas<textarea name="notes" rows="2"></textarea></label>
      <label class="check"><input type="checkbox" name="force" /> Permitir fuera de horario / sobreturno</label>
      <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button>Guardar turno</button></div>
    </form>`);
  const f = $('#f', m);
  const fillPrices = () => {
    const svc = services.find((x) => x.id === Number(f.serviceId.value));
    if (svc) {
      f.price.value = svc.price;
      f.depositAmount.value = svc.deposit_amount;
    }
  };
  const hint = async () => {
    if (!f.date.value || !f.serviceId.value) return;
    try {
      const { slots } = await adminApi(`/api/admin/appointments/slots?serviceId=${f.serviceId.value}&date=${f.date.value}`);
      $('#slot-hint', m).innerHTML = slots.length
        ? `Libres: ${slots.map((x) => `<button type="button" class="link" data-t="${x}">${x}</button>`).join(' ')}`
        : 'No hay horarios libres ese día (podés forzar un sobreturno).';
      $$('[data-t]', m).forEach((b) => (b.onclick = () => (f.time.value = b.dataset.t)));
    } catch {
      $('#slot-hint', m).textContent = '';
    }
  };
  f.serviceId.onchange = () => (fillPrices(), hint());
  f.date.onchange = hint;
  fillPrices();
  hint();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = formData(f);
    body.force = f.force.checked;
    const appt = await act(() => adminApi('/api/admin/appointments', { method: 'POST', body }), 'Turno guardado');
    if (appt) {
      m.remove();
      if (app.view === 'agenda') VIEWS.agenda();
      openAppointment(appt.id);
    }
  };
}

async function openAppointment(id) {
  const a = await act(() => adminApi(`/api/admin/appointments/${id}`));
  if (!a) return;
  const pendingDeposit = Math.max(0, a.deposit_amount - a.deposit_paid);
  const active = !['cancelled', 'completed'].includes(a.status);
  const m = modal(
    `
    <div class="row between"><h2 style="margin:0">${esc(a.client_name)}</h2>${statusBadge(a.status)}</div>
    <p class="muted">${esc(a.client_phone || '')} ${a.client_email ? `· ${esc(a.client_email)}` : ''}</p>
    ${a.alert ? `<div class="alert danger">${esc(a.alert)}</div>` : ''}
    <div class="summary-line"><span>Servicio</span><b>${esc(a.service_name)}</b></div>
    <div class="summary-line"><span>Día y hora</span><b>${fmtDate(a.date)} · ${a.start_time} a ${a.end_time}</b></div>
    <div class="summary-line"><span>Precio</span><span>${fmtMoney(a.price)}</span></div>
    <div class="summary-line"><span>Seña</span><span>${fmtMoney(a.deposit_paid)} de ${fmtMoney(a.deposit_amount)}</span></div>
    ${a.balance_paid ? `<div class="summary-line"><span>Cobrado en local</span><span>${fmtMoney(a.balance_paid)}</span></div>` : ''}
    <div class="summary-line total"><span>Saldo</span><span>${fmtMoney(a.balance)}</span></div>
    <small class="muted">Origen: ${a.source === 'web' ? 'reserva web' : 'cargado en el local'}${a.mp_payment_id ? ` · Pago MP #${a.mp_payment_id}` : ''}</small>
    <div style="margin-top:0.4rem">${waBadge(a)}</div>
    <label style="margin-top:1rem">Notas<textarea id="notes" rows="2">${esc(a.notes || '')}</textarea></label>

    <div class="row" style="margin-top:0.5rem">
      ${active && a.balance > 0 ? '<button id="charge">Cobrar saldo en caja</button>' : ''}
      ${active && a.status !== 'completed' && a.balance === 0 ? '<button id="done">Marcar atendido</button>' : ''}
      ${['pending_payment', 'expired', 'no_show'].includes(a.status) ? '<button class="secondary" id="confirm">Confirmar</button>' : ''}
      ${active && pendingDeposit > 0 ? '<button class="secondary" id="dep">Cobrar seña</button><button class="secondary" id="deplink">Link de seña MP</button>' : ''}
      ${active || a.status === 'expired' ? '<button class="secondary" id="move">Reprogramar</button>' : ''}
      ${a.status === 'confirmed' ? '<button class="secondary" id="noshow">No vino</button>' : ''}
      ${a.status !== 'cancelled' && a.status !== 'completed' ? '<button class="danger" id="cancel">Cancelar turno</button>' : ''}
    </div>
    <div class="row" style="margin-top:0.5rem">
      ${a.mp_configured && a.mp_preference_id && pendingDeposit > 0 ? '<button class="secondary small" id="checkpay">Verificar pago en Mercado Pago</button>' : ''}
      ${a.wa_configured && ['confirmed', 'completed'].includes(a.status) ? `<button class="secondary small" id="wasend">${a.wa_status === 'sent' ? 'Reenviar' : 'Enviar'} confirmación por WhatsApp</button>` : ''}
      ${a.wa_link ? `<a class="btn secondary small" target="_blank" href="${esc(a.wa_link)}">Abrir WhatsApp con el mensaje</a>` : ''}
    </div>
    <div id="extra"></div>
    <div class="actions"><button class="secondary" data-close>Cerrar</button></div>`,
    { wide: false }
  );
  const refresh = () => {
    m.remove();
    if (VIEWS[app.view] && ['agenda', 'inicio'].includes(app.view)) VIEWS[app.view]();
    openAppointment(id);
  };
  const setStatus = (status) => act(() => adminApi(`/api/admin/appointments/${id}/status`, { method: 'POST', body: { status } }), 'Turno actualizado').then((r) => r && refresh());

  $('#notes', m).addEventListener('change', (e) => act(() => adminApi(`/api/admin/appointments/${id}/notes`, { method: 'PUT', body: { notes: e.target.value } }), 'Notas guardadas'));
  const on = (sel, fn) => $(sel, m) && ($(sel, m).onclick = fn);
  on('#confirm', () => setStatus('confirmed'));
  on('#noshow', () => setStatus('no_show'));
  on('#done', () => setStatus('completed'));
  on('#charge', () => {
    m.remove();
    if (!app.cart.some((l) => l.appointmentId === a.id)) {
      app.cart.push({ appointmentId: a.id, description: `${a.service_name} - ${a.client_name} (saldo)`, quantity: 1, unitPrice: a.balance, fixedQty: true });
    }
    location.hash = 'caja';
    if (app.view === 'caja') route();
  });
  on('#checkpay', async () => {
    const r = await act(() => adminApi(`/api/admin/appointments/${id}/check-payment`, { method: 'POST' }));
    if (!r) return;
    toast(r.approved ? '¡Pago encontrado! Turno confirmado' : r.payments ? 'Hay intentos de pago pero ninguno aprobado todavía' : 'Todavía no hay pagos para este turno');
    if (r.approved) refresh();
  });
  on('#wasend', async () => {
    const r = await act(() => adminApi(`/api/admin/appointments/${id}/whatsapp`, { method: 'POST' }), 'Mensaje de WhatsApp enviado');
    if (r) refresh();
  });
  on('#dep', () => {
    $('#extra', m).innerHTML = `<form id="depf" class="card" style="margin-top:1rem"><h3>Cobrar seña</h3>
      <div class="grid cols-2"><label>Importe<input name="amount" type="number" step="0.01" min="0" value="${pendingDeposit}" required /></label>
      <label>Medio de pago<select name="method">${methodOptions()}</select></label></div>
      <div class="row end"><button>Registrar seña</button></div></form>`;
    $('#depf', m).onsubmit = async (e) => {
      e.preventDefault();
      const r = await act(() => adminApi(`/api/admin/appointments/${id}/deposit`, { method: 'POST', body: formData(e.target) }), 'Seña registrada');
      if (r) refresh();
    };
  });
  on('#deplink', async () => {
    const r = await act(() => adminApi(`/api/admin/appointments/${id}/deposit-link`, { method: 'POST' }));
    if (!r) return;
    $('#extra', m).innerHTML = `<div class="card" style="margin-top:1rem;text-align:center"><h3>Link de pago de la seña</h3>
      <img class="qr" src="${r.qr}" alt="QR" />
      <input readonly value="${esc(r.init_point)}" onclick="this.select()" />
      <div class="row" style="justify-content:center;margin-top:0.6rem">
        <button class="secondary small" id="copy">Copiar link</button>
        ${r.whatsapp ? `<a class="btn small" target="_blank" href="${esc(r.whatsapp)}">Enviar por WhatsApp</a>` : ''}
      </div><p class="muted">Cuando se acredite, el turno se actualiza solo.</p></div>`;
    $('#copy', m).onclick = () => navigator.clipboard.writeText(r.init_point).then(() => toast('Link copiado'));
  });
  on('#move', () => {
    $('#extra', m).innerHTML = `<form id="mvf" class="card" style="margin-top:1rem"><h3>Reprogramar</h3>
      <div class="grid cols-2"><label>Fecha<input type="date" name="date" value="${a.date}" required /></label>
      <label>Hora<input type="time" name="time" value="${a.start_time}" required /></label></div>
      <label class="check"><input type="checkbox" name="force" /> Permitir sobreturno / fuera de horario</label>
      <div class="row end"><button>Guardar</button></div></form>`;
    $('#mvf', m).onsubmit = async (e) => {
      e.preventDefault();
      const body = formData(e.target);
      body.force = e.target.force.checked;
      const r = await act(() => adminApi(`/api/admin/appointments/${id}/reschedule`, { method: 'POST', body }), 'Turno reprogramado');
      if (r) refresh();
    };
  });
  on('#cancel', () => {
    $('#extra', m).innerHTML = `<div class="card" style="margin-top:1rem"><h3>Cancelar turno</h3>
      ${a.deposit_paid > 0 && a.mp_payment_id ? `<label class="check"><input type="checkbox" id="refund" /> Devolver la seña (${fmtMoney(a.deposit_paid)}) por Mercado Pago</label>` : ''}
      ${a.deposit_paid > 0 && !a.mp_payment_id ? '<p class="muted">La seña se cobró en el local. Si la devolvés, registrá un egreso en la caja.</p>' : ''}
      <div class="row end"><button class="danger" id="cancel-ok">Confirmar cancelación</button></div></div>`;
    $('#cancel-ok', m).onclick = async () => {
      const refund = $('#refund', m) ? $('#refund', m).checked : false;
      const r = await act(() => adminApi(`/api/admin/appointments/${id}/cancel`, { method: 'POST', body: { refund } }), 'Turno cancelado');
      if (r) refresh();
    };
  });
}

// ---------- Caja ----------

VIEWS.caja = async () => {
  const [data, products, services] = await Promise.all([
    adminApi('/api/admin/cash'),
    adminApi('/api/admin/products'),
    loadServices(),
  ]);
  const tab = app.query.get('tab') || 'cobrar';
  if (!data.session) return renderCashClosed(data);
  const s = data.session;
  $('#main').innerHTML = `
    <div class="page-head"><h1>Caja <small class="muted">abierta ${fmtDateTime(s.session.opened_at)}</small></h1>
      <div class="row"><button class="secondary" id="mov">Ingreso / egreso</button><button class="danger" id="close">Cerrar caja</button></div></div>
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Total del día</div><div class="value">${fmtMoney(s.total)}</div></div>
      <div class="card stat"><div class="label">Efectivo en caja</div><div class="value">${fmtMoney(s.expectedCash)}</div><small class="muted">inicial ${fmtMoney(s.session.opening_amount)}</small></div>
      <div class="card stat"><div class="label">Mercado Pago</div><div class="value">${fmtMoney(s.byMethod.mercadopago)}</div></div>
      <div class="card stat"><div class="label">Tarjetas / transf.</div><div class="value">${fmtMoney((s.byMethod.debito || 0) + (s.byMethod.credito || 0) + (s.byMethod.transferencia || 0))}</div></div>
    </div>
    ${data.pendingSales.length ? `<div class="alert warn">${data.pendingSales.length} cobro(s) con Mercado Pago esperando el pago. <a href="#caja?tab=ventas">Ver</a></div>` : ''}
    <div class="tabs">
      ${[['cobrar', 'Cobrar'], ['movimientos', 'Movimientos'], ['ventas', 'Ventas'], ['historial', 'Cajas anteriores']]
        .map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`)
        .join('')}
    </div>
    <div id="tab"></div>`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => (location.hash = `caja?tab=${b.dataset.tab}`)));
  $('#mov').onclick = () => cashMovementModal();
  $('#close').onclick = () => closeCashModal(s);
  if (tab === 'cobrar') renderPos(products, services);
  if (tab === 'movimientos') $('#tab').innerHTML = `<div class="card">${movementsTable(data.movements)}</div>`;
  if (tab === 'ventas') renderSales(data);
  if (tab === 'historial') renderCashHistory();
};

function renderCashClosed(data) {
  $('#main').innerHTML = `
    <div class="page-head"><h1>Caja</h1></div>
    <div class="card" style="max-width:420px">
      <h2>Abrir caja</h2>
      <form id="open"><label>Efectivo inicial<input name="openingAmount" type="number" step="0.01" min="0" value="0" /></label>
      <button>Abrir caja</button></form>
    </div>
    ${data.pendingSales.length ? `<div class="card"><h2>Cobros pendientes de Mercado Pago</h2>${salesTable(data.pendingSales)}</div>` : ''}
    ${data.unassigned.length ? `<div class="card"><h2>Movimientos con la caja cerrada</h2><p class="muted">Señas y pagos de Mercado Pago que se acreditaron mientras la caja estaba cerrada.</p>${movementsTable(data.unassigned)}</div>` : ''}
    <div class="card"><h2>Cajas anteriores</h2><div id="hist"></div></div>`;
  $('#open').onsubmit = async (e) => {
    e.preventDefault();
    if (await act(() => adminApi('/api/admin/cash/open', { method: 'POST', body: formData(e.target) }), 'Caja abierta')) route();
  };
  renderCashHistory($('#hist'));
  bindSaleActions();
}

function renderPos(products, services) {
  const today0 = today();
  $('#tab').innerHTML = `
    <div class="pos">
      <div class="card">
        <div class="row" style="margin-bottom:0.8rem">
          <input id="psearch" class="grow" placeholder="Buscar producto por nombre o SKU (Enter agrega si hay uno solo)" />
        </div>
        <h3>Servicios</h3>
        <div class="product-grid" style="max-height:none;margin-bottom:1rem">
          ${services.filter((x) => x.active).map((x) => `<button class="product-tile" data-svc="${x.id}"><b>${esc(x.name)}</b><small>${fmtMoney(x.price)}</small></button>`).join('')}
          <button class="product-tile" id="free"><b>Otro concepto</b><small>Importe libre</small></button>
        </div>
        <div class="row between"><h3>Turnos de hoy con saldo</h3></div>
        <div id="today-appts" class="muted">Cargando…</div>
        <h3 style="margin-top:1rem">Productos</h3>
        <div class="product-grid" id="pgrid"></div>
      </div>
      <div class="card">
        <h2>Venta</h2>
        <div id="cart"></div>
        <div class="grid cols-2" style="margin-top:0.8rem">
          <label>Descuento<input id="discount" type="number" step="0.01" min="0" value="0" /></label>
          <label>Medio de pago<select id="method">${methodOptions()}<option value="mp_link">Mercado Pago (link / QR)</option></select></label>
        </div>
        <div class="summary-line total"><span>Total</span><span id="total">$ 0</span></div>
        <button id="pay" style="width:100%;margin-top:0.8rem">Cobrar</button>
      </div>
    </div>`;

  const renderProducts = (q = '') => {
    const ql = q.toLowerCase();
    const list = products.filter((p) => p.active && (!ql || p.name.toLowerCase().includes(ql) || (p.sku || '').toLowerCase().includes(ql)));
    $('#pgrid').innerHTML = list.length
      ? list.map((p) => `<button class="product-tile" data-prod="${p.id}" ${p.stock <= 0 ? 'style="opacity:.55"' : ''}><b>${esc(p.name)}</b><small>${fmtMoney(p.price)} · stock ${p.stock}</small></button>`).join('')
      : '<p class="muted">Sin productos.</p>';
    $$('[data-prod]').forEach((b) => (b.onclick = () => addProduct(products.find((p) => p.id === Number(b.dataset.prod)))));
    return list;
  };
  const addProduct = (p) => {
    const line = app.cart.find((l) => l.productId === p.id);
    if (line) line.quantity++;
    else app.cart.push({ productId: p.id, description: p.name, quantity: 1, unitPrice: p.price, stock: p.stock });
    renderCart();
  };
  renderProducts();
  $('#psearch').oninput = (e) => renderProducts(e.target.value);
  $('#psearch').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const list = renderProducts(e.target.value);
    if (list.length === 1) {
      addProduct(list[0]);
      e.target.value = '';
      renderProducts();
    }
  };
  $$('[data-svc]').forEach(
    (b) =>
      (b.onclick = () => {
        const s = services.find((x) => x.id === Number(b.dataset.svc));
        app.cart.push({ serviceId: s.id, description: s.name, quantity: 1, unitPrice: s.price });
        renderCart();
      })
  );
  $('#free').onclick = () => {
    app.cart.push({ description: '', quantity: 1, unitPrice: 0, free: true });
    renderCart();
  };

  adminApi(`/api/admin/appointments?from=${today0}&to=${today0}`).then((list) => {
    const withBalance = list.filter((a) => a.balance > 0 && ['confirmed', 'pending_payment'].includes(a.status));
    $('#today-appts').innerHTML = withBalance.length
      ? withBalance
          .map((a) => `<button class="secondary small" data-ap="${a.id}" style="margin:0 0.3rem 0.3rem 0">${a.start_time} ${esc(a.client_name)} · ${fmtMoney(a.balance)}</button>`)
          .join('')
      : '<span class="muted">No hay turnos con saldo pendiente hoy.</span>';
    $$('[data-ap]').forEach(
      (b) =>
        (b.onclick = () => {
          const a = withBalance.find((x) => x.id === Number(b.dataset.ap));
          if (app.cart.some((l) => l.appointmentId === a.id)) return;
          app.cart.push({ appointmentId: a.id, description: `${a.service_name} - ${a.client_name} (saldo)`, quantity: 1, unitPrice: a.balance, fixedQty: true });
          renderCart();
        })
    );
  });

  $('#discount').oninput = renderTotals;
  $('#pay').onclick = paySale;
  renderCart();
}

function renderCart() {
  const el = $('#cart');
  if (!el) return;
  if (!app.cart.length) {
    el.innerHTML = '<p class="muted">Agregá productos, servicios o turnos.</p>';
    renderTotals();
    return;
  }
  el.innerHTML = app.cart
    .map(
      (l, i) => `<div class="cart-line">
        ${l.free ? `<input data-i="${i}" data-f="description" placeholder="Concepto" value="${esc(l.description)}" />` : `<span>${esc(l.description)}</span>`}
        <input data-i="${i}" data-f="quantity" type="number" min="1" step="1" value="${l.quantity}" ${l.fixedQty ? 'disabled' : ''} />
        <input data-i="${i}" data-f="unitPrice" type="number" min="0" step="0.01" value="${l.unitPrice}" />
        <button class="danger small" data-del="${i}" title="Quitar">✕</button>
      </div>`
    )
    .join('');
  $$('[data-f]', el).forEach(
    (inp) =>
      (inp.oninput = () => {
        const l = app.cart[Number(inp.dataset.i)];
        l[inp.dataset.f] = inp.dataset.f === 'description' ? inp.value : Number(inp.value);
        renderTotals();
      })
  );
  $$('[data-del]', el).forEach(
    (b) =>
      (b.onclick = () => {
        app.cart.splice(Number(b.dataset.del), 1);
        renderCart();
      })
  );
  renderTotals();
}

function cartTotal() {
  const sub = app.cart.reduce((a, l) => a + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);
  return Math.max(0, sub - (Number($('#discount') && $('#discount').value) || 0));
}

function renderTotals() {
  if ($('#total')) $('#total').textContent = fmtMoney(cartTotal());
}

async function paySale() {
  if (!app.cart.length) return toast('La venta está vacía', 'error');
  const method = $('#method').value;
  const items = app.cart.map((l) => {
    if (l.productId) return { productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice };
    if (l.appointmentId) return { appointmentId: l.appointmentId, amount: l.unitPrice };
    if (l.serviceId) return { serviceId: l.serviceId, quantity: l.quantity, unitPrice: l.unitPrice };
    return { description: l.description, quantity: l.quantity, unitPrice: l.unitPrice };
  });
  $('#pay').disabled = true;
  const r = await act(() => adminApi('/api/admin/sales', { method: 'POST', body: { items, discount: $('#discount').value, method } }));
  $('#pay').disabled = false;
  if (!r) return;
  app.cart = [];
  if (r.init_point) showPaymentQr(r.sale, r);
  else toast(`Venta #${r.sale.id} cobrada: ${fmtMoney(r.sale.total)}`);
  route();
}

function showPaymentQr(sale, link) {
  const m = modal(`<h2>Cobro con Mercado Pago</h2>
    <p>Venta #${sale.id} · <b>${fmtMoney(sale.total)}</b></p>
    <p class="muted">La clienta escanea el QR con la app de Mercado Pago o su cámara.</p>
    <img class="qr" src="${link.qr}" alt="QR de pago" />
    <input readonly value="${esc(link.init_point)}" onclick="this.select()" />
    <div id="qr-status" class="alert warn" style="margin-top:1rem">Esperando el pago…</div>
    <details><summary class="muted">¿No se actualiza?</summary>
      <form id="chk" class="row" style="margin-top:0.5rem"><input name="paymentId" placeholder="N° de operación de Mercado Pago" class="grow" /><button class="secondary small">Verificar</button></form>
    </details>
    <div class="actions"><button class="secondary" data-close>Cerrar</button></div>`);
  $('#chk', m).onsubmit = async (e) => {
    e.preventDefault();
    await act(() => adminApi('/api/admin/payments/check', { method: 'POST', body: formData(e.target) }));
  };
  const poll = setInterval(async () => {
    if (!document.body.contains(m)) return clearInterval(poll);
    const s = await adminApi(`/api/admin/sales/${sale.id}`).catch(() => null);
    if (s && s.status === 'paid') {
      clearInterval(poll);
      $('#qr-status', m).className = 'alert ok';
      $('#qr-status', m).textContent = '¡Pago acreditado!';
      if (app.view === 'caja') route();
    }
  }, 3000);
}

function movementsTable(list) {
  if (!list.length) return '<p class="muted">Sin movimientos.</p>';
  return `<div class="table-wrap"><table>
    <tr><th>Hora</th><th>Tipo</th><th>Detalle</th><th>Medio</th><th class="num">Importe</th></tr>
    ${list
      .map(
        (m) => `<tr><td>${fmtDateTime(m.created_at)}</td><td>${CASH_TYPES[m.type] || m.type}</td><td>${esc(m.description || '')}
          ${m.appointment_id ? ` <button class="link" data-appt="${m.appointment_id}">turno</button>` : ''}</td>
          <td>${METHOD_LABELS[m.payment_method] || m.payment_method}</td>
          <td class="num" style="color:${m.amount < 0 ? 'var(--danger)' : 'inherit'}">${fmtMoney(m.amount)}</td></tr>`
      )
      .join('')}
  </table></div>`;
}

function salesTable(list) {
  if (!list.length) return '<p class="muted">Sin ventas.</p>';
  const badge = { paid: '<span class="badge ok">Cobrada</span>', pending: '<span class="badge warn">Esperando pago</span>', cancelled: '<span class="badge gray">Anulada</span>' };
  return `<div class="table-wrap"><table>
    <tr><th>#</th><th>Fecha</th><th>Detalle</th><th>Medio</th><th class="num">Total</th><th>Estado</th><th></th></tr>
    ${list
      .map(
        (s) => `<tr><td>${s.id}</td><td>${fmtDateTime(s.created_at)}</td><td>${esc(s.detail || '')}</td>
        <td>${METHOD_LABELS[s.payment_method] || s.payment_method}</td><td class="num">${fmtMoney(s.total)}</td><td>${badge[s.status] || s.status}</td>
        <td style="white-space:nowrap">
          ${s.status === 'pending' ? `<button class="secondary small" data-qr="${s.id}">QR</button> <button class="secondary small" data-paid="${s.id}">Cobrada en otro medio</button>` : ''}
          ${s.status !== 'cancelled' ? `<button class="danger small" data-cancel="${s.id}">Anular</button>` : ''}
        </td></tr>`
      )
      .join('')}
  </table></div>`;
}

function renderSales(data) {
  $('#tab').innerHTML = `
    ${data.pendingSales.length ? `<div class="card"><h2>Esperando pago (Mercado Pago)</h2>${salesTable(data.pendingSales)}</div>` : ''}
    <div class="card"><h2>Ventas de esta caja</h2>${salesTable(data.sales)}</div>`;
  bindSaleActions();
}

function bindSaleActions() {
  $$('[data-qr]').forEach(
    (b) =>
      (b.onclick = async () => {
        const id = Number(b.dataset.qr);
        const [sale, link] = await Promise.all([adminApi(`/api/admin/sales/${id}`), act(() => adminApi(`/api/admin/sales/${id}/link`, { method: 'POST' }))]);
        if (link) showPaymentQr(sale, link);
      })
  );
  $$('[data-paid]').forEach(
    (b) =>
      (b.onclick = () => {
        const m = modal(`<h2>Registrar cobro de venta #${b.dataset.paid}</h2><form id="pf"><label>Medio de pago<select name="method">${methodOptions()}</select></label>
          <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button>Registrar</button></div></form>`);
        $('#pf', m).onsubmit = async (e) => {
          e.preventDefault();
          if (await act(() => adminApi(`/api/admin/sales/${b.dataset.paid}/pay`, { method: 'POST', body: formData(e.target) }), 'Venta cobrada')) {
            m.remove();
            route();
          }
        };
      })
  );
  $$('[data-cancel]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm(`¿Anular la venta #${b.dataset.cancel}? Se repone el stock y se registra la salida de dinero.`)) return;
        if (await act(() => adminApi(`/api/admin/sales/${b.dataset.cancel}/cancel`, { method: 'POST' }), 'Venta anulada')) route();
      })
  );
  bindApptClicks($('#main'));
}

async function renderCashHistory(target) {
  const el = target || $('#tab');
  const list = await adminApi('/api/admin/cash/sessions');
  el.innerHTML = `<div class="${target ? '' : 'card'}">${
    list.length
      ? `<div class="table-wrap"><table><tr><th>#</th><th>Apertura</th><th>Cierre</th><th class="num">Inicial</th><th class="num">Esperado</th><th class="num">Contado</th><th class="num">Diferencia</th><th></th></tr>
      ${list
        .map(
          (s) => `<tr><td>${s.id}</td><td>${fmtDateTime(s.opened_at)} <small class="muted">${esc(s.opened_by_name || '')}</small></td>
          <td>${s.closed_at ? fmtDateTime(s.closed_at) : '<span class="badge ok">Abierta</span>'}</td>
          <td class="num">${fmtMoney(s.opening_amount)}</td><td class="num">${s.closed_at ? fmtMoney(s.expected_cash) : '-'}</td>
          <td class="num">${s.closed_at ? fmtMoney(s.counted_amount) : '-'}</td>
          <td class="num">${s.closed_at ? `<span class="badge ${Math.abs(s.difference) < 0.01 ? 'ok' : 'danger'}">${fmtMoney(s.difference)}</span>` : '-'}</td>
          <td><button class="secondary small" data-sess="${s.id}">Ver</button></td></tr>`
        )
        .join('')}</table></div>`
      : '<p class="muted">Todavía no hay cajas.</p>'
  }</div>`;
  $$('[data-sess]', el).forEach(
    (b) =>
      (b.onclick = async () => {
        const d = await adminApi(`/api/admin/cash/sessions/${b.dataset.sess}`);
        modal(
          `<h2>Caja #${d.session.id}</h2>
          <div class="grid cols-3">${Object.entries(d.byMethod)
            .map(([k, v]) => `<div class="card stat"><div class="label">${METHOD_LABELS[k]}</div><div class="value">${fmtMoney(v)}</div></div>`)
            .join('')}</div>
          ${d.session.notes ? `<p><b>Notas:</b> ${esc(d.session.notes)}</p>` : ''}
          <h3>Movimientos</h3>${movementsTable(d.movements)}
          <div class="actions"><button class="secondary" data-close>Cerrar</button></div>`,
          { wide: true }
        );
      })
  );
}

function cashMovementModal() {
  const m = modal(`<h2>Ingreso / egreso de caja</h2><form id="f">
    <div class="grid cols-2"><label>Tipo<select name="type"><option value="expense">Egreso (pago, retiro)</option><option value="income">Ingreso</option></select></label>
    <label>Medio<select name="method">${methodOptions()}</select></label></div>
    <label>Importe<input name="amount" type="number" step="0.01" min="0" required /></label>
    <label>Descripción<input name="description" required placeholder="Ej: pago de limpieza, retiro, cambio" /></label>
    <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button>Registrar</button></div></form>`);
  $('#f', m).onsubmit = async (e) => {
    e.preventDefault();
    if (await act(() => adminApi('/api/admin/cash/movements', { method: 'POST', body: formData(e.target) }), 'Movimiento registrado')) {
      m.remove();
      route();
    }
  };
}

function closeCashModal(s) {
  const m = modal(`<h2>Cerrar caja</h2>
    <table>${Object.entries(s.byMethod).map(([k, v]) => `<tr><td>${METHOD_LABELS[k]}</td><td class="num">${fmtMoney(v)}</td></tr>`).join('')}
    <tr><td><b>Efectivo esperado en caja</b> <small class="muted">(inicial + movimientos en efectivo)</small></td><td class="num"><b>${fmtMoney(s.expectedCash)}</b></td></tr></table>
    <form id="f" style="margin-top:1rem"><label>Efectivo contado<input name="countedAmount" type="number" step="0.01" min="0" required value="${s.expectedCash}" /></label>
    <div id="diff" class="muted"></div>
    <label>Notas<textarea name="notes" rows="2"></textarea></label>
    <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button class="danger">Cerrar caja</button></div></form>`);
  const f = $('#f', m);
  f.countedAmount.oninput = () => {
    const d = Number(f.countedAmount.value) - s.expectedCash;
    $('#diff', m).textContent = Math.abs(d) < 0.01 ? 'Sin diferencias' : `Diferencia: ${fmtMoney(d)}`;
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const r = await act(() => adminApi('/api/admin/cash/close', { method: 'POST', body: formData(f) }), 'Caja cerrada');
    if (r) {
      m.remove();
      route();
    }
  };
}

// ---------- Ventas web (Tienda Nube) ----------

const PAYMENT_STATUS = {
  paid: ['Pagado', 'ok'],
  pending: ['Pago pendiente', 'warn'],
  authorized: ['Autorizado', 'warn'],
  abandoned: ['Abandonado', 'gray'],
  refunded: ['Reembolsado', 'danger'],
  voided: ['Anulado', 'danger'],
};
const SHIPPING_STATUS = {
  unpacked: ['Sin empaquetar', 'warn'],
  unshipped: ['Sin enviar', 'warn'],
  unfulfilled: ['Sin enviar', 'warn'],
  packed: ['Empaquetado', 'info'],
  fulfilled: ['Enviado', 'ok'],
  shipped: ['Enviado', 'ok'],
  delivered: ['Entregado', 'ok'],
};
const MP_STATUS = { approved: 'Aprobado', pending: 'Pendiente', in_process: 'En revisión', rejected: 'Rechazado', refunded: 'Devuelto', cancelled: 'Cancelado', charged_back: 'Contracargo' };
const pick = (map, k) => {
  const [label, cls] = map[k] || [k || '-', 'gray'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
};
const orderStatusBadge = (o) =>
  o.status === 'cancelled' ? '<span class="badge gray">Cancelada</span>' : `${pick(PAYMENT_STATUS, o.payment_status)} ${o.shipping_pickup ? '<span class="badge info">Retira en local</span>' : pick(SHIPPING_STATUS, o.shipping_status)}`;
const STOCK_LABEL = { applied: ['Stock descontado', 'ok'], reverted: ['Stock repuesto', 'info'], not_applied: ['Anterior a la conexión: stock sin mover', 'gray'] };

app.web = { q: '', payment: '', shipping: '' };

VIEWS.ventasweb = async () => {
  const f = app.web;
  if (app.query.get('shipping')) f.shipping = app.query.get('shipping');
  const qs = new URLSearchParams({ q: f.q, payment: f.payment, shipping: f.shipping });
  const d = await adminApi(`/api/admin/web-orders?${qs}`);
  updateWebBadge(d.stats);
  if (!d.connected && !d.orders.length) {
    $('#main').innerHTML = `<div class="page-head"><h1>Ventas web</h1></div>
      <div class="card"><p>Conectá Tienda Nube para ver acá las ventas de tu tienda online. <a href="#config?tab=tn">Ir a la configuración</a></p></div>`;
    return;
  }
  const totalPaid = d.orders.filter((o) => o.payment_status === 'paid' && o.status !== 'cancelled').reduce((a, o) => a + (o.total || 0), 0);
  $('#main').innerHTML = `
    <div class="page-head"><h1>Ventas web</h1>
      <div class="row"><small class="muted">${d.lastSync ? `Actualizado ${fmtDateTime(d.lastSync)}` : ''}</small><button class="secondary" id="sync">Actualizar ahora</button></div></div>
    <div class="grid cols-3">
      <div class="card stat"><div class="label">Para preparar / enviar</div><div class="value">${d.stats.to_ship || 0}</div></div>
      <div class="card stat"><div class="label">Pago pendiente</div><div class="value">${d.stats.unpaid || 0}</div></div>
      <div class="card stat"><div class="label">Cobrado (en este listado)</div><div class="value">${fmtMoney(totalPaid)}</div></div>
    </div>
    <div class="card row">
      <input id="q" class="grow" placeholder="Buscar por cliente, email, teléfono, DNI o N° de orden" value="${esc(f.q)}" style="min-width:200px" />
      <select id="payment" style="width:auto"><option value="">Todos los pagos</option>
        ${Object.entries(PAYMENT_STATUS).map(([k, [l]]) => `<option value="${k}" ${f.payment === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="shipping" style="width:auto"><option value="">Todos los envíos</option>
        <option value="pending" ${f.shipping === 'pending' ? 'selected' : ''}>Pagadas sin enviar</option>
        <option value="fulfilled" ${f.shipping === 'fulfilled' ? 'selected' : ''}>Enviadas</option></select>
    </div>
    <div class="card">${
      d.orders.length
        ? `<div class="table-wrap"><table><tr><th>Orden</th><th>Fecha</th><th>Cliente</th><th>Productos</th><th class="num">Total</th><th>Estado</th></tr>
          ${d.orders
            .map(
              (o) => `<tr data-wo="${o.id}" style="cursor:pointer;${o.seen_at ? '' : 'font-weight:600'}">
              <td>#${esc(o.number || o.tn_order_id)} ${o.seen_at ? '' : '<span class="badge warn">Nueva</span>'}</td>
              <td>${fmtDateTime(o.ordered_at)}</td>
              <td>${esc(o.customer_name)}<br><small class="muted">${esc(o.shipping_city || (o.shipping_pickup ? 'Retiro' : ''))}${o.shipping_province ? `, ${esc(o.shipping_province)}` : ''}</small></td>
              <td><small>${o.items.map((i) => `${i.quantity}x ${esc(i.name)}`).join('<br>')}</small></td>
              <td class="num">${fmtMoney(o.total)}</td>
              <td>${orderStatusBadge(o)}</td></tr>`
            )
            .join('')}</table></div>`
        : '<p class="muted">No hay ventas web con estos filtros.</p>'
    }</div>`;
  const reload = () => VIEWS.ventasweb();
  $('#sync').onclick = async () => {
    $('#sync').disabled = true;
    const r = await act(() => adminApi('/api/admin/web-orders/sync', { method: 'POST', body: {} }));
    if (r) toast(r.skipped ? 'Ya se está actualizando' : `Listo: ${r.synced} orden(es) revisadas`);
    reload();
  };
  $('#payment').onchange = (e) => ((f.payment = e.target.value), reload());
  $('#shipping').onchange = (e) => {
    f.shipping = e.target.value;
    if (app.query.get('shipping')) location.hash = 'ventasweb';
    else reload();
  };
  let t;
  $('#q').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      f.q = e.target.value;
      reload().then(() => {
        const q = $('#q');
        q.focus();
        q.setSelectionRange(q.value.length, q.value.length);
      });
    }, 400);
  };
  $$('[data-wo]').forEach((tr) => (tr.onclick = () => openWebOrder(Number(tr.dataset.wo))));
};

async function openWebOrder(id) {
  const o = await act(() => adminApi(`/api/admin/web-orders/${id}`));
  if (!o) return;
  const phone = (o.customer_phone || '').replace(/\D/g, '');
  const wa = phone ? `https://wa.me/${phone.startsWith('54') ? phone : `549${phone.replace(/^0/, '')}`}` : null;
  const shippingBlock = o.shipping_pickup
    ? `<p><b>Retira en el local</b>${o.shipping_method ? ` · ${esc(o.shipping_method)}` : ''}</p>`
    : `<pre id="ship-text" style="white-space:pre-wrap;background:var(--bg);padding:0.8rem;border-radius:8px;font-family:inherit;margin:0">${esc(
        [
          o.shipping_name,
          o.shipping_address,
          [o.shipping_zipcode ? `CP ${o.shipping_zipcode}` : '', o.shipping_city, o.shipping_province].filter(Boolean).join(', '),
          o.shipping_phone ? `Tel: ${o.shipping_phone}` : '',
          o.customer_dni ? `DNI: ${o.customer_dni}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      )}</pre>
      <div class="row between" style="margin-top:0.4rem"><small class="muted">${esc(o.shipping_method || '')}</small><button class="secondary small" id="copy-ship">Copiar datos de envío</button></div>`;
  const [stockLabel, stockCls] = STOCK_LABEL[o.stock_status] || ['-', 'gray'];
  const m = modal(
    `<div class="row between"><h2 style="margin:0">Venta web #${esc(o.number || o.tn_order_id)}</h2><div>${orderStatusBadge(o)}</div></div>
    <p class="muted">${fmtDateTime(o.ordered_at)}${o.cancelled_at ? ` · cancelada ${fmtDateTime(o.cancelled_at)}` : ''}</p>
    <div class="grid cols-2">
      <div class="card"><h3>Cliente</h3>
        <b>${esc(o.customer_name)}</b><br>
        ${o.customer_dni ? `DNI: ${esc(o.customer_dni)}<br>` : ''}
        ${o.customer_email ? `<a href="mailto:${esc(o.customer_email)}">${esc(o.customer_email)}</a><br>` : ''}
        ${o.customer_phone ? `${esc(o.customer_phone)} ${wa ? `· <a href="${esc(wa)}" target="_blank">WhatsApp</a>` : ''}` : ''}
        ${o.customer_note ? `<div class="alert warn" style="margin:0.6rem 0 0"><b>Nota del cliente:</b> ${esc(o.customer_note)}</div>` : ''}
      </div>
      <div class="card"><h3>Envío</h3>${shippingBlock}
        ${o.shipping_tracking ? `<p style="margin-bottom:0">Seguimiento: ${o.shipping_tracking_url ? `<a href="${esc(o.shipping_tracking_url)}" target="_blank">${esc(o.shipping_tracking)}</a>` : esc(o.shipping_tracking)}</p>` : ''}
        ${o.shipped_at ? `<small class="muted">Enviado ${fmtDateTime(o.shipped_at)}</small>` : ''}
      </div>
    </div>
    <div class="card"><h3>Productos</h3>
      <div class="table-wrap"><table><tr><th>Producto</th><th>SKU</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Subtotal</th></tr>
      ${o.items
        .map(
          (i) => `<tr><td>${esc(i.name)}${i.variant ? ` <small class="muted">(${esc(i.variant)})</small>` : ''}
            ${i.product_id ? '' : '<br><span class="badge warn">No vinculado al stock del sistema</span>'}</td>
            <td>${esc(i.sku || '')}</td><td class="num">${i.quantity}</td><td class="num">${fmtMoney(i.price)}</td><td class="num">${fmtMoney(i.subtotal)}</td></tr>`
        )
        .join('')}
      </table></div>
      <div style="max-width:320px;margin-left:auto">
        <div class="summary-line"><span>Subtotal</span><span>${fmtMoney(o.subtotal)}</span></div>
        ${o.discount ? `<div class="summary-line"><span>Descuentos</span><span>-${fmtMoney(o.discount)}</span></div>` : ''}
        <div class="summary-line"><span>Envío</span><span>${o.shipping_cost ? fmtMoney(o.shipping_cost) : 'Gratis'}</span></div>
        <div class="summary-line total"><span>Total</span><span>${fmtMoney(o.total)}</span></div>
      </div>
      <span class="badge ${stockCls}">${stockLabel}</span>
    </div>
    <div class="card"><h3>Pago</h3>
      <div class="summary-line"><span>Estado en Tienda Nube</span><span>${pick(PAYMENT_STATUS, o.payment_status)}</span></div>
      <div class="summary-line"><span>Medio</span><span>${esc(o.gateway || '-')}${o.payment_detail ? ` · ${esc(o.payment_detail)}` : ''}</span></div>
      ${o.gateway_id ? `<div class="summary-line"><span>N° de operación</span><span>${esc(o.gateway_id)}</span></div>` : ''}
      ${o.paid_at ? `<div class="summary-line"><span>Fecha de pago</span><span>${fmtDateTime(o.paid_at)}</span></div>` : ''}
      <div id="mp-check"></div>
      <div class="row end" style="margin-top:0.6rem"><button class="secondary small" id="verify">Corroborar pago en Mercado Pago</button></div>
    </div>
    ${o.owner_note ? `<div class="alert info"><b>Nota interna (Tienda Nube):</b> ${esc(o.owner_note)}</div>` : ''}
    <div class="actions"><button class="secondary" data-close>Cerrar</button></div>`,
    { wide: true }
  );
  if ($('#copy-ship', m)) $('#copy-ship', m).onclick = () => navigator.clipboard.writeText($('#ship-text', m).textContent).then(() => toast('Datos de envío copiados'));
  $('#verify', m).onclick = async () => {
    const r = await act(() => adminApi(`/api/admin/web-orders/${id}/verify-payment`, { method: 'POST' }));
    if (!r) return;
    $('#mp-check', m).innerHTML = !r.verifiable
      ? `<div class="alert warn" style="margin-top:0.6rem">${esc(r.message)}</div>`
      : `<div class="alert ${r.status === 'approved' && r.matches_total ? 'ok' : 'danger'}" style="margin-top:0.6rem">
          <b>Mercado Pago: ${esc(MP_STATUS[r.status] || r.status)}</b> · operación ${esc(r.payment_id)}<br>
          Importe cobrado: ${fmtMoney(r.amount)}${r.net_amount !== null ? ` (neto recibido ${fmtMoney(r.net_amount)})` : ''}
          ${r.matches_total ? '' : `<br><b>Atención:</b> el importe no coincide con el total de la orden (${fmtMoney(o.total)}).`}
          ${r.date_approved ? `<br>Aprobado: ${new Date(r.date_approved).toLocaleString('es-AR')}` : ''}
          ${r.method ? `<br>Medio: ${esc(r.method)}` : ''}${r.payer ? ` · Pagador: ${esc(r.payer)}` : ''}</div>`;
  };
  if (app.view === 'ventasweb') {
    const row = $(`[data-wo="${id}"]`);
    if (row) {
      row.style.fontWeight = '';
      const b = $('.badge.warn', row.firstElementChild);
      if (b) {
        b.remove();
        const badge = $('#web-badge');
        const n = Math.max(0, (Number(badge.textContent) || 0) - 1);
        updateWebBadge({ unseen: n });
      }
    }
  }
}

// ---------- Stock ----------

VIEWS.stock = async () => {
  const tab = app.query.get('tab') || 'productos';
  $('#main').innerHTML = `
    <div class="page-head"><h1>Stock</h1><button id="new">+ Nuevo producto</button></div>
    <div class="tabs">${[['productos', 'Productos'], ['movimientos', 'Movimientos']]
      .map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`)
      .join('')}</div>
    <div id="tab"></div>`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => (location.hash = `stock?tab=${b.dataset.tab}`)));
  $('#new').onclick = () => productModal();
  if (tab === 'movimientos') {
    const list = await adminApi('/api/admin/stock-movements?limit=500');
    $('#tab').innerHTML = `<div class="card">${stockMovementsTable(list, true)}</div>`;
    return;
  }
  $('#tab').innerHTML = `<div class="card"><input id="q" placeholder="Buscar por nombre o SKU" value="${esc(app.stockQ || '')}" style="margin-bottom:0.8rem" /><div id="plist"></div></div>`;
  const load = async () => {
    const list = await adminApi(`/api/admin/products?q=${encodeURIComponent(app.stockQ || '')}`);
    const syncBadge = (p) =>
      !p.tn_product_id
        ? p.tn_sync_status === 'error'
          ? `<span class="badge danger" title="${esc(p.tn_sync_error || '')}">Error</span>`
          : '<span class="badge gray">No vinculado</span>'
        : p.tn_sync_status === 'error'
          ? `<span class="badge danger" title="${esc(p.tn_sync_error || '')}">Error</span>`
          : '<span class="badge ok">Sincronizado</span>';
    $('#plist').innerHTML = list.length
      ? `<div class="table-wrap"><table><tr><th>SKU</th><th>Producto</th><th class="num">Precio</th><th class="num">Stock</th><th>Tienda Nube</th><th></th></tr>
        ${list
          .map(
            (p) => `<tr style="${p.active ? '' : 'opacity:.5'}"><td>${esc(p.sku || '')}</td><td>${esc(p.name)}${p.active ? '' : ' <span class="badge gray">inactivo</span>'}</td>
            <td class="num">${fmtMoney(p.price)}</td>
            <td class="num"><span class="badge ${p.stock <= 0 ? 'danger' : p.stock <= p.min_stock ? 'warn' : 'ok'}">${p.stock}</span></td>
            <td>${syncBadge(p)}</td>
            <td style="white-space:nowrap"><button class="small" data-adj="${p.id}">Ajustar</button>
              <button class="secondary small" data-edit="${p.id}">Editar</button>
              <button class="secondary small" data-hist="${p.id}">Movimientos</button></td></tr>`
          )
          .join('')}</table></div>`
      : '<p class="muted">No hay productos. Cargalos o importalos desde Tienda Nube (Configuración).</p>';
    $$('[data-adj]').forEach((b) => (b.onclick = () => adjustModal(list.find((p) => p.id === Number(b.dataset.adj)))));
    $$('[data-edit]').forEach((b) => (b.onclick = () => productModal(list.find((p) => p.id === Number(b.dataset.edit)))));
    $$('[data-hist]').forEach(
      (b) =>
        (b.onclick = async () => {
          const p = list.find((x) => x.id === Number(b.dataset.hist));
          const mv = await adminApi(`/api/admin/stock-movements?productId=${p.id}`);
          modal(`<h2>${esc(p.name)}</h2>${stockMovementsTable(mv)}<div class="actions"><button class="secondary" data-close>Cerrar</button></div>`, { wide: true });
        })
    );
  };
  let t;
  $('#q').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => ((app.stockQ = e.target.value), load()), 300);
  };
  await load();
};

function stockMovementsTable(list, withProduct = false) {
  if (!list.length) return '<p class="muted">Sin movimientos.</p>';
  return `<div class="table-wrap"><table><tr><th>Fecha</th>${withProduct ? '<th>Producto</th>' : ''}<th>Tipo</th><th>Motivo</th><th class="num">Cantidad</th><th class="num">Stock</th><th>Usuario</th></tr>
    ${list
      .map(
        (m) => `<tr><td>${fmtDateTime(m.created_at)}</td>${withProduct ? `<td>${esc(m.product_name)}</td>` : ''}<td>${STOCK_TYPES[m.type] || m.type}</td>
        <td>${esc(m.reason || '')}</td><td class="num" style="color:${m.quantity < 0 ? 'var(--danger)' : 'var(--ok)'}">${m.quantity > 0 ? '+' : ''}${m.quantity}</td>
        <td class="num">${m.stock_after}</td><td>${esc(m.username || (m.type.startsWith('tiendanube') ? 'Tienda Nube' : ''))}</td></tr>`
      )
      .join('')}</table></div>`;
}

function adjustModal(p) {
  const m = modal(`<h2>Ajustar stock</h2><p><b>${esc(p.name)}</b> · stock actual: <b>${p.stock}</b></p>
    <form id="f">
      <label>Tipo de ajuste<select name="mode">
        <option value="add">Entrada (+)</option><option value="remove">Salida / rotura / uso interno (−)</option><option value="set">Conteo físico (fijar stock)</option>
      </select></label>
      <label>Cantidad<input name="quantity" type="number" step="1" min="0" required /></label>
      <label>Motivo<input name="reason" required placeholder="Ej: ingreso de mercadería, vencido, conteo mensual" list="reasons" />
        <datalist id="reasons"><option>Ingreso de mercadería</option><option>Rotura</option><option>Vencido</option><option>Uso interno</option><option>Conteo físico</option></datalist></label>
      <div class="muted" id="prev"></div>
      <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button>Guardar ajuste</button></div>
    </form>`);
  const f = $('#f', m);
  const preview = () => {
    const q = Number(f.quantity.value) || 0;
    const after = f.mode.value === 'set' ? q : f.mode.value === 'add' ? p.stock + q : p.stock - q;
    $('#prev', m).textContent = `Stock resultante: ${after}`;
  };
  f.oninput = preview;
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (await act(() => adminApi(`/api/admin/products/${p.id}/adjust`, { method: 'POST', body: formData(f) }), 'Stock actualizado')) {
      m.remove();
      VIEWS.stock();
    }
  };
}

function productModal(p = null) {
  const m = modal(`<h2>${p ? 'Editar producto' : 'Nuevo producto'}</h2><form id="f">
    <div class="grid cols-2"><label>Nombre<input name="name" required value="${esc(p?.name || '')}" /></label>
    <label>SKU / código<input name="sku" value="${esc(p?.sku || '')}" /></label></div>
    <label>Descripción<textarea name="description" rows="2">${esc(p?.description || '')}</textarea></label>
    <div class="grid cols-3"><label>Precio<input name="price" type="number" step="0.01" min="0" required value="${p?.price ?? ''}" /></label>
    ${p ? '' : '<label>Stock inicial<input name="stock" type="number" step="1" min="0" value="0" /></label>'}
    <label>Stock mínimo (alerta)<input name="min_stock" type="number" step="1" min="0" value="${p?.min_stock ?? 0}" /></label></div>
    <label class="check"><input type="checkbox" name="publish_online" ${!p || p.publish_online ? 'checked' : ''} /> Publicar en Tienda Nube</label>
    <label class="check"><input type="checkbox" name="active" ${!p || p.active ? 'checked' : ''} /> Activo</label>
    ${p && p.tn_product_id ? `<p class="muted">Vinculado a Tienda Nube (producto ${esc(p.tn_product_id)})${p.tn_last_sync ? ` · última sincronización ${fmtDateTime(p.tn_last_sync)}` : ''}</p>` : ''}
    ${p && p.tn_sync_error ? `<div class="alert danger">${esc(p.tn_sync_error)}</div>` : ''}
    <div class="actions">
      ${p ? '<button type="button" class="danger" id="del">Eliminar</button><button type="button" class="secondary" id="sync">Sincronizar ahora</button>' : ''}
      <button type="button" class="secondary" data-close>Cancelar</button><button>Guardar</button></div></form>`);
  const f = $('#f', m);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = formData(f);
    body.active = f.active.checked;
    body.publish_online = f.publish_online.checked;
    const r = await act(() => adminApi(p ? `/api/admin/products/${p.id}` : '/api/admin/products', { method: p ? 'PUT' : 'POST', body }), 'Producto guardado');
    if (r) {
      m.remove();
      VIEWS.stock();
    }
  };
  if (p) {
    $('#del', m).onclick = async () => {
      if (!confirm('¿Eliminar el producto? Si tiene ventas o está en Tienda Nube se desactiva.')) return;
      const r = await act(() => adminApi(`/api/admin/products/${p.id}`, { method: 'DELETE' }));
      if (r) {
        toast(r.deactivated ? 'Producto desactivado' : 'Producto eliminado');
        m.remove();
        VIEWS.stock();
      }
    };
    $('#sync', m).onclick = async () => {
      if (await act(() => adminApi(`/api/admin/products/${p.id}/sync`, { method: 'POST' }), 'Sincronizado con Tienda Nube')) {
        m.remove();
        VIEWS.stock();
      }
    };
  }
}

// ---------- Clientas ----------

VIEWS.clientes = async () => {
  $('#main').innerHTML = `<div class="page-head"><h1>Clientas</h1></div>
    <div class="card"><input id="q" placeholder="Buscar por nombre, teléfono o email" style="margin-bottom:0.8rem" /><div id="list"></div></div>`;
  const load = async (q = '') => {
    const list = await adminApi(`/api/admin/clients?q=${encodeURIComponent(q)}`);
    $('#list').innerHTML = list.length
      ? `<div class="table-wrap"><table><tr><th>Nombre</th><th>Teléfono</th><th>Email</th><th class="num">Visitas</th><th>Última</th><th></th></tr>
        ${list
          .map(
            (c) => `<tr><td>${esc(c.name)}</td><td>${c.phone ? `<a target="_blank" href="https://wa.me/${c.phone.startsWith('54') ? c.phone : `54${c.phone}`}">${esc(c.phone)}</a>` : ''}</td>
            <td>${esc(c.email || '')}</td><td class="num">${c.visits}</td><td>${c.last_visit ? fmtDate(c.last_visit, { day: '2-digit', month: '2-digit', year: '2-digit' }) : ''}</td>
            <td><button class="secondary small" data-edit="${c.id}">Editar</button> <button class="secondary small" data-turnos="${esc(c.phone || c.name)}">Turnos</button></td></tr>`
          )
          .join('')}</table></div>`
      : '<p class="muted">Sin resultados.</p>';
    $$('[data-turnos]').forEach(
      (b) =>
        (b.onclick = () => {
          Object.assign(app.agenda, { q: b.dataset.turnos, from: addDays(today(), -180), days: 30, status: '' });
          location.hash = 'agenda';
        })
    );
    $$('[data-edit]').forEach(
      (b) =>
        (b.onclick = () => {
          const c = list.find((x) => x.id === Number(b.dataset.edit));
          const m = modal(`<h2>Editar clienta</h2><form id="f">
            <label>Nombre<input name="name" required value="${esc(c.name)}" /></label>
            <div class="grid cols-2"><label>Teléfono<input name="phone" value="${esc(c.phone || '')}" /></label><label>Email<input name="email" value="${esc(c.email || '')}" /></label></div>
            <label>Notas (tipo de piel, preferencias…)<textarea name="notes" rows="3">${esc(c.notes || '')}</textarea></label>
            <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button>Guardar</button></div></form>`);
          $('#f', m).onsubmit = async (e) => {
            e.preventDefault();
            if (await act(() => adminApi(`/api/admin/clients/${c.id}`, { method: 'PUT', body: formData(e.target) }), 'Guardado')) {
              m.remove();
              load($('#q').value);
            }
          };
        })
    );
  };
  let t;
  $('#q').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => load(e.target.value), 300);
  };
  await load();
};

// ---------- Configuración ----------

VIEWS.config = async () => {
  const tab = app.query.get('tab') || (app.query.get('tn') ? 'tn' : 'negocio');
  const tabs = [
    ['negocio', 'Negocio y agenda'],
    ['servicios', 'Servicios'],
    ['horarios', 'Horarios'],
    ['mp', 'Mercado Pago'],
    ['wa', 'WhatsApp'],
    ['tn', 'Tienda Nube'],
    ['usuarios', 'Usuarios'],
  ];
  $('#main').innerHTML = `<div class="page-head"><h1>Configuración</h1></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="tab"><p class="muted">Cargando…</p></div>`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => (location.hash = `config?tab=${b.dataset.tab}`)));
  if (app.query.get('tn') === 'ok') toast('Tienda Nube conectada');
  await CONFIG_TABS[tab]();
};

async function saveSettings(form, msg = 'Configuración guardada') {
  const body = formData(form);
  $$('input[type=checkbox]', form).forEach((c) => (body[c.name] = c.checked ? '1' : '0'));
  return act(() => adminApi('/api/admin/settings', { method: 'PUT', body }), msg);
}

const CONFIG_TABS = {
  async negocio() {
    const s = await adminApi('/api/admin/settings');
    $('#tab').innerHTML = `<form class="card" id="f">
      <h2>Datos del negocio</h2>
      <div class="grid cols-2">
        <label>Nombre<input name="business_name" value="${esc(s.business_name)}" /></label>
        <label>Teléfono / WhatsApp<input name="business_phone" value="${esc(s.business_phone)}" /></label>
      </div>
      <label>Dirección<input name="business_address" value="${esc(s.business_address)}" /></label>
      <label>URL pública del sistema (https)<input name="public_url" value="${esc(s.public_url)}" placeholder="https://turnos.miestetica.com.ar" />
        <small>Necesaria para que Mercado Pago y Tienda Nube avisen los pagos y ventas automáticamente.</small></label>
      <h2 style="margin-top:1rem">Reservas online</h2>
      <div class="grid cols-3">
        <label>Intervalo entre turnos (min)<input name="slot_interval_min" type="number" min="5" value="${esc(s.slot_interval_min)}" /></label>
        <label>Clientas al mismo tiempo (camas/cabinas)<input name="capacity" type="number" min="1" value="${esc(s.capacity)}" /></label>
        <label>Días hacia adelante para reservar<input name="booking_window_days" type="number" min="1" value="${esc(s.booking_window_days)}" /></label>
        <label>Anticipación mínima (min)<input name="min_advance_min" type="number" min="0" value="${esc(s.min_advance_min)}" /></label>
        <label>Minutos para pagar la seña<input name="booking_hold_min" type="number" min="5" value="${esc(s.booking_hold_min)}" /></label>
      </div>
      <label>Condiciones (se muestran al reservar)<textarea name="booking_terms" rows="3">${esc(s.booking_terms)}</textarea></label>
      <div class="row end"><button>Guardar</button></div></form>`;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      await saveSettings(e.target);
    };
  },

  async servicios() {
    const list = await loadServices();
    $('#tab').innerHTML = `<div class="card"><div class="row between"><h2>Servicios</h2><button id="new">+ Nuevo servicio</button></div>
      <p class="muted">La seña es lo que se cobra por Mercado Pago al reservar online. Si es 0, el turno se confirma sin pago.</p>
      <div class="table-wrap"><table><tr><th>Servicio</th><th class="num">Duración</th><th class="num">Precio</th><th class="num">Seña</th><th>Estado</th><th></th></tr>
      ${list
        .map(
          (s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.duration_min} min</td><td class="num">${fmtMoney(s.price)}</td><td class="num">${fmtMoney(s.deposit_amount)}</td>
          <td>${s.active ? '<span class="badge ok">Activo</span>' : '<span class="badge gray">Inactivo</span>'}</td>
          <td><button class="secondary small" data-edit="${s.id}">Editar</button></td></tr>`
        )
        .join('')}</table></div></div>`;
    const edit = (s = null) => {
      const m = modal(`<h2>${s ? 'Editar' : 'Nuevo'} servicio</h2><form id="f">
        <label>Nombre<input name="name" required value="${esc(s?.name || '')}" /></label>
        <label>Descripción<textarea name="description" rows="2">${esc(s?.description || '')}</textarea></label>
        <div class="grid cols-3"><label>Duración (min)<input name="duration_min" type="number" min="5" step="5" required value="${s?.duration_min ?? 30}" /></label>
        <label>Precio<input name="price" type="number" step="0.01" min="0" required value="${s?.price ?? ''}" /></label>
        <label>Seña<input name="deposit_amount" type="number" step="0.01" min="0" value="${s?.deposit_amount ?? 0}" /></label></div>
        <label>Orden<input name="sort" type="number" value="${s?.sort ?? 0}" /></label>
        <label class="check"><input type="checkbox" name="active" ${!s || s.active ? 'checked' : ''} /> Disponible para reservar</label>
        <div class="actions">${s ? '<button type="button" class="danger" id="del">Eliminar</button>' : ''}<button type="button" class="secondary" data-close>Cancelar</button><button>Guardar</button></div></form>`);
      $('#f', m).onsubmit = async (e) => {
        e.preventDefault();
        const body = formData(e.target);
        body.active = e.target.active.checked;
        if (await act(() => adminApi(s ? `/api/admin/services/${s.id}` : '/api/admin/services', { method: s ? 'PUT' : 'POST', body }), 'Servicio guardado')) {
          m.remove();
          CONFIG_TABS.servicios();
        }
      };
      if (s)
        $('#del', m).onclick = async () => {
          if (!confirm('¿Eliminar el servicio? Si tiene turnos se desactiva.')) return;
          if (await act(() => adminApi(`/api/admin/services/${s.id}`, { method: 'DELETE' }), 'Listo')) {
            m.remove();
            CONFIG_TABS.servicios();
          }
        };
    };
    $('#new').onclick = () => edit();
    $$('[data-edit]').forEach((b) => (b.onclick = () => edit(list.find((x) => x.id === Number(b.dataset.edit)))));
  },

  async horarios() {
    const [hours, blocked] = await Promise.all([adminApi('/api/admin/hours'), adminApi('/api/admin/blocked-dates')]);
    const rows = [...hours];
    const render = () => {
      $('#hours').innerHTML = [1, 2, 3, 4, 5, 6, 0]
        .map((d) => {
          const ranges = rows.map((r, i) => ({ ...r, i })).filter((r) => r.weekday === d);
          return `<div class="row" style="padding:0.4rem 0;border-bottom:1px dashed var(--border)">
            <b style="width:100px">${WEEKDAYS[d]}</b>
            ${ranges.length ? '' : '<span class="muted">Cerrado</span>'}
            ${ranges
              .map(
                (r) => `<span class="row" style="gap:0.3rem"><input type="time" data-i="${r.i}" data-k="start_time" value="${r.start_time}" style="width:auto" />
                a <input type="time" data-i="${r.i}" data-k="end_time" value="${r.end_time}" style="width:auto" />
                <button type="button" class="danger small" data-rm="${r.i}">✕</button></span>`
              )
              .join('')}
            <button type="button" class="secondary small" data-add="${d}">+ franja</button></div>`;
        })
        .join('');
      $$('#hours [data-k]').forEach((inp) => (inp.onchange = () => (rows[Number(inp.dataset.i)][inp.dataset.k] = inp.value)));
      $$('#hours [data-rm]').forEach((b) => (b.onclick = () => (rows.splice(Number(b.dataset.rm), 1), render())));
      $$('#hours [data-add]').forEach((b) => (b.onclick = () => (rows.push({ weekday: Number(b.dataset.add), start_time: '10:00', end_time: '19:00' }), render())));
    };
    $('#tab').innerHTML = `<div class="card"><h2>Horario de atención</h2><div id="hours"></div>
      <div class="row end" style="margin-top:1rem"><button id="save">Guardar horarios</button></div></div>
      <div class="card"><h2>Días sin atención (feriados, vacaciones)</h2>
      <form id="bf" class="row"><input type="date" name="date" required style="width:auto" /><input name="reason" placeholder="Motivo" class="grow" /><button>Agregar</button></form>
      <table style="margin-top:0.8rem">${blocked
        .map((b) => `<tr><td>${fmtDate(b.date)}</td><td>${esc(b.reason || '')}</td><td class="num"><button class="danger small" data-unblock="${b.id}">Quitar</button></td></tr>`)
        .join('')}</table></div>`;
    render();
    $('#save').onclick = () =>
      act(() => adminApi('/api/admin/hours', { method: 'PUT', body: rows.map(({ weekday, start_time, end_time }) => ({ weekday, start_time, end_time })) }), 'Horarios guardados');
    $('#bf').onsubmit = async (e) => {
      e.preventDefault();
      if (await act(() => adminApi('/api/admin/blocked-dates', { method: 'POST', body: formData(e.target) }), 'Día bloqueado')) CONFIG_TABS.horarios();
    };
    $$('[data-unblock]').forEach(
      (b) => (b.onclick = async () => (await act(() => adminApi(`/api/admin/blocked-dates/${b.dataset.unblock}`, { method: 'DELETE' }))) && CONFIG_TABS.horarios())
    );
  },

  async mp() {
    const [s, integ] = await Promise.all([adminApi('/api/admin/settings'), adminApi('/api/admin/integrations')]);
    const webhook = integ.publicUrl ? `${integ.publicUrl}/api/webhooks/mercadopago` : '(configurá la URL pública en "Negocio y agenda")';
    $('#tab').innerHTML = `<form class="card" id="f">
      <h2>Mercado Pago ${integ.mercadopago.configured ? '<span class="badge ok">Configurado</span>' : '<span class="badge warn">Sin configurar</span>'}</h2>
      <p class="muted">Obtené las credenciales en <a href="https://www.mercadopago.com.ar/developers/panel/app" target="_blank">Mercado Pago Developers → Tus integraciones</a>
      (creá una aplicación de tipo "Pagos online / Checkout Pro"). Para pruebas usá las credenciales de prueba (TEST-…).</p>
      <label>Access Token<input name="mp_access_token" value="${esc(s.mp_access_token)}" placeholder="APP_USR-… o TEST-…" autocomplete="off" /></label>
      <label>Public Key<input name="mp_public_key" value="${esc(s.mp_public_key)}" autocomplete="off" /></label>
      <label>Clave secreta de webhooks (opcional, recomendado)<input name="mp_webhook_secret" value="${esc(s.mp_webhook_secret)}" autocomplete="off" />
        <small>En tu aplicación → Webhooks: configurá la URL <code>${esc(webhook)}</code> con el evento "Pagos" y copiá acá la clave secreta.</small></label>
      <label class="check"><input type="checkbox" name="mp_auto_check" ${s.mp_auto_check === '1' ? 'checked' : ''} /> Verificar automáticamente cada minuto si las reservas pendientes ya se pagaron</label>
      <div class="row end"><button type="button" class="secondary" id="checknow">Verificar pagos pendientes ahora</button><button type="button" class="secondary" id="test">Probar conexión</button><button>Guardar</button></div>
    </form>
    <div class="card"><h2>Actividad reciente</h2>${logTable(integ.mercadopago.log)}</div>`;
    $('#checknow').onclick = async () => {
      const r = await act(() => adminApi('/api/admin/integrations/mercadopago/check-now', { method: 'POST' }));
      if (r) toast(r.skipped ? 'Mercado Pago no está configurado' : `Revisados: ${r.checked} · pagos encontrados: ${r.approved}${r.errors ? ` · errores: ${r.errors}` : ''}`);
    };
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      if (await saveSettings(e.target)) CONFIG_TABS.mp();
    };
    $('#test').onclick = async () => {
      const r = await act(() => adminApi('/api/admin/integrations/mercadopago/test', { method: 'POST' }));
      if (r) toast(`Conectado a la cuenta ${r.account}${r.test ? ' (modo prueba)' : ''}`);
    };
  },

  async wa() {
    const [s, integ] = await Promise.all([adminApi('/api/admin/settings'), adminApi('/api/admin/integrations')]);
    const w = integ.whatsapp;
    $('#tab').innerHTML = `<form class="card" id="f">
      <h2>WhatsApp ${w.enabled ? '<span class="badge ok">Envío automático activo</span>' : w.configured ? '<span class="badge warn">Configurado, envío desactivado</span>' : '<span class="badge warn">Sin configurar</span>'}</h2>
      <p class="muted">Cuando se acredita la seña, el sistema le manda a la clienta la confirmación del turno por WhatsApp.
        Usa la API oficial de WhatsApp (Meta), que exige una <b>plantilla de mensaje aprobada</b>. Ver los pasos abajo.</p>
      <label class="check"><input type="checkbox" name="wa_enabled" ${s.wa_enabled === '1' ? 'checked' : ''} /> Enviar confirmación automática al recibir la seña</label>
      <label>Indicaciones para la clienta (se incluyen en el mensaje)<textarea name="wa_info" rows="3">${esc(s.wa_info)}</textarea>
        <small>En el mensaje automático los saltos de línea se reemplazan por " · " (limitación de WhatsApp).</small></label>
      <div class="grid cols-2">
        <label>Token de acceso<input name="wa_token" value="${esc(s.wa_token)}" autocomplete="off" placeholder="EAAG…" /></label>
        <label>ID del número de teléfono (Phone number ID)<input name="wa_phone_number_id" value="${esc(s.wa_phone_number_id)}" autocomplete="off" /></label>
        <label>Nombre de la plantilla<input name="wa_template_name" value="${esc(s.wa_template_name)}" /></label>
        <label>Idioma de la plantilla<input name="wa_template_lang" value="${esc(s.wa_template_lang)}" placeholder="es_AR" /></label>
      </div>
      <label>Variables de la plantilla, en orden ({{1}}, {{2}}, …)<input name="wa_template_vars" value="${esc(s.wa_template_vars)}" />
        <small>Disponibles: ${w.fields.join(', ')}</small></label>
      <div class="row end"><button>Guardar</button></div>
    </form>
    <form class="card row" id="t"><input name="phone" class="grow" placeholder="Tu celular para probar (ej: 11 2345 6789)" required /><button class="secondary">Enviar mensaje de prueba</button></form>
    <div class="card"><h2>Cómo configurarlo</h2>
      <ol>
        <li>Entrá a <a href="https://developers.facebook.com/apps" target="_blank">developers.facebook.com</a>, creá una app de tipo <b>Empresa</b> y agregale el producto <b>WhatsApp</b>.</li>
        <li>En <b>WhatsApp → Configuración de la API</b> agregá y verificá el número del local (no puede estar usándose en la app de WhatsApp común; podés usar uno nuevo o migrarlo). Copiá el <b>Phone number ID</b>.</li>
        <li>En <b>business.facebook.com → Configuración → Usuarios del sistema</b> creá un usuario de sistema, asignale la app y generá un <b>token permanente</b> con los permisos <code>whatsapp_business_messaging</code> y <code>whatsapp_business_management</code>.</li>
        <li>En <b>WhatsApp Manager → Plantillas de mensajes</b> creá una plantilla de categoría <b>Utilidad</b>, idioma <b>Español (ARG)</b>, llamada <code>confirmacion_turno</code>, con este texto:
          <pre style="white-space:pre-wrap;background:var(--bg);padding:0.8rem;border-radius:8px">¡Hola {{1}}! Tu turno de {{2}} está confirmado ✅
📅 {{3}} a las {{4}}
Para tener en cuenta: {{5}}
¡Te esperamos!</pre>
          Esperá a que Meta la apruebe (suele tardar minutos u horas).</li>
        <li>Cargá acá el token, el Phone number ID y el nombre de la plantilla, mandate un mensaje de prueba y activá el envío automático.</li>
      </ol>
      <p class="muted">Mientras tanto, desde cada turno podés usar <b>Abrir WhatsApp con el mensaje</b> para mandarlo a mano con tu WhatsApp.</p>
    </div>
    <div class="card"><h2>Actividad reciente</h2>${logTable(w.log)}</div>`;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      if (await saveSettings(e.target)) CONFIG_TABS.wa();
    };
    $('#t').onsubmit = async (e) => {
      e.preventDefault();
      const r = await act(() => adminApi('/api/admin/integrations/whatsapp/test', { method: 'POST', body: formData(e.target) }));
      if (r) toast(`Mensaje de prueba enviado a +${r.to}`);
    };
  },

  async tn() {
    const [s, integ] = await Promise.all([adminApi('/api/admin/settings'), adminApi('/api/admin/integrations')]);
    const t = integ.tiendanube;
    const callback = `${integ.publicUrl || location.origin}/integraciones/tiendanube/callback`;
    $('#tab').innerHTML = `
    <div class="card">
      <h2>Tienda Nube ${t.configured ? `<span class="badge ok">Conectada (tienda ${esc(t.storeId)})</span>` : '<span class="badge warn">Sin conectar</span>'}</h2>
      <p class="muted">Los productos y el stock del sistema se replican en tu tienda online. Cuando entra una venta en Tienda Nube, el stock se descuenta acá automáticamente.</p>
      ${
        t.configured
          ? `<div class="row">
              <button id="test" class="secondary">Probar conexión</button>
              <button id="import">Importar productos de Tienda Nube</button>
              <button id="push" class="secondary">Enviar todo el stock a Tienda Nube</button>
              <button id="hooks" class="secondary">Registrar webhooks</button>
              <button id="disc" class="danger">Desconectar</button>
            </div>
            <p class="muted" style="margin-top:0.6rem">${t.linked} producto(s) vinculados${t.queue ? ` · ${t.queue} pendiente(s) de enviar` : ''}.</p>`
          : ''
      }
    </div>
    <form class="card" id="f">
      <h2>Conexión</h2>
      <p class="muted"><b>Opción A (recomendada):</b> creá una app en el <a href="https://partners.tiendanube.com" target="_blank">Portal de Socios de Tienda Nube</a>
        con permisos de <i>Products</i> (lectura/escritura) y <i>Orders</i> (lectura), y como URL de redirección <code>${esc(callback)}</code>.
        Cargá el App ID y el Client Secret, guardá y tocá "Conectar con Tienda Nube".</p>
      <div class="grid cols-2">
        <label>App ID (client_id)<input name="tn_client_id" value="${esc(s.tn_client_id)}" autocomplete="off" /></label>
        <label>Client Secret<input name="tn_client_secret" value="${esc(s.tn_client_secret)}" autocomplete="off" /></label>
      </div>
      <p class="muted"><b>Opción B:</b> si ya tenés un access token y el ID de la tienda, cargalos directamente.</p>
      <div class="grid cols-2">
        <label>Store ID (user_id)<input name="tn_store_id" value="${esc(s.tn_store_id)}" autocomplete="off" /></label>
        <label>Access Token<input name="tn_access_token" value="${esc(s.tn_access_token)}" autocomplete="off" /></label>
      </div>
      <label>User-Agent (nombre de la app y email de contacto, lo exige Tienda Nube)<input name="tn_user_agent" value="${esc(s.tn_user_agent)}" placeholder="Mi Estética (contacto@miestetica.com)" /></label>
      <label class="check"><input type="checkbox" name="tn_auto_sync" ${s.tn_auto_sync === '1' ? 'checked' : ''} /> Enviar automáticamente cada cambio de stock / producto</label>
      <label class="check"><input type="checkbox" name="tn_sync_price" ${s.tn_sync_price === '1' ? 'checked' : ''} /> Actualizar también los precios en la web</label>
      <div class="row end"><button type="button" class="secondary" id="connect">Conectar con Tienda Nube</button><button>Guardar</button></div>
    </form>
    ${t.errors.length ? `<div class="card"><h2>Errores de sincronización</h2><table>${t.errors.map((e) => `<tr><td>${esc(e.name)}</td><td>${esc(e.tn_sync_error || '')}</td></tr>`).join('')}</table></div>` : ''}
    <div class="card"><h2>Actividad reciente</h2>${logTable(t.log)}</div>`;

    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      if (await saveSettings(e.target)) CONFIG_TABS.tn();
    };
    $('#connect').onclick = async () => {
      const r = await act(() => adminApi('/api/admin/integrations/tiendanube/install-url'));
      if (r) location.href = r.url;
    };
    const on = (sel, fn) => $(sel) && ($(sel).onclick = fn);
    on('#test', async () => {
      const r = await act(() => adminApi('/api/admin/integrations/tiendanube/test', { method: 'POST' }));
      if (r) toast(`Conectado a "${r.store.name}"`);
    });
    on('#import', () => {
      const m = modal(`<h2>Importar productos</h2>
        <p>Se traen todos los productos de Tienda Nube (cada variante es un producto). Los que ya existen acá se vinculan por SKU.</p>
        <label>Para los productos que ya existen en ambos lados, usar el stock de:
        <select id="from"><option value="remote">Tienda Nube</option><option value="local">Este sistema (y actualizar la web)</option></select></label>
        <div class="actions"><button class="secondary" data-close>Cancelar</button><button id="go">Importar</button></div>`);
      $('#go', m).onclick = async () => {
        $('#go', m).disabled = true;
        $('#go', m).textContent = 'Importando…';
        const r = await act(() => adminApi('/api/admin/integrations/tiendanube/import', { method: 'POST', body: { stockFrom: $('#from', m).value } }));
        m.remove();
        if (r) toast(`Importados: ${r.created} nuevos, ${r.linked} vinculados, ${r.updated} actualizados`);
        CONFIG_TABS.tn();
      };
    });
    on('#push', async () => {
      if (!confirm('Se va a enviar el stock y los datos de todos los productos a Tienda Nube. Los productos que no existen en la web se crean. ¿Continuar?')) return;
      toast('Enviando… puede tardar unos minutos');
      const r = await act(() => adminApi('/api/admin/integrations/tiendanube/push-all', { method: 'POST' }));
      if (r) toast(`Listo: ${r.ok} enviados${r.errors ? `, ${r.errors} con error` : ''}`);
      CONFIG_TABS.tn();
    });
    on('#hooks', async () => {
      const r = await act(() => adminApi('/api/admin/integrations/tiendanube/webhooks', { method: 'POST' }));
      if (r) toast('Webhooks registrados');
    });
    on('#disc', async () => {
      if (!confirm('¿Desconectar Tienda Nube? Los productos quedan vinculados por si volvés a conectar la misma tienda.')) return;
      if (await act(() => adminApi('/api/admin/integrations/tiendanube/disconnect', { method: 'POST' }), 'Desconectado')) CONFIG_TABS.tn();
    });
  },

  async usuarios() {
    const list = await adminApi('/api/admin/users');
    $('#tab').innerHTML = `<div class="grid cols-2">
      <div class="card"><h2>Usuarios</h2><table>${list
        .map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.name || '')}</td><td class="num">${u.id === app.user.id ? '<small class="muted">vos</small>' : `<button class="danger small" data-del="${u.id}">Eliminar</button>`}</td></tr>`)
        .join('')}</table>
        <form id="nu" style="margin-top:1rem"><h3>Nuevo usuario</h3>
        <div class="grid cols-2"><label>Usuario<input name="username" required /></label><label>Nombre<input name="name" /></label></div>
        <label>Contraseña<input name="password" type="password" required minlength="6" /></label><button>Crear usuario</button></form></div>
      <form class="card" id="pw"><h2>Cambiar mi contraseña</h2>
        <label>Contraseña actual<input name="current" type="password" required /></label>
        <label>Nueva contraseña<input name="password" type="password" required minlength="6" /></label>
        <button>Cambiar contraseña</button></form></div>`;
    $('#nu').onsubmit = async (e) => {
      e.preventDefault();
      if (await act(() => adminApi('/api/admin/users', { method: 'POST', body: formData(e.target) }), 'Usuario creado')) CONFIG_TABS.usuarios();
    };
    $('#pw').onsubmit = async (e) => {
      e.preventDefault();
      if (await act(() => adminApi('/api/admin/me/password', { method: 'POST', body: formData(e.target) }), 'Contraseña actualizada')) e.target.reset();
    };
    $$('[data-del]').forEach(
      (b) =>
        (b.onclick = async () => {
          if (confirm('¿Eliminar este usuario?') && (await act(() => adminApi(`/api/admin/users/${b.dataset.del}`, { method: 'DELETE' }), 'Usuario eliminado'))) CONFIG_TABS.usuarios();
        })
    );
  },
};

function logTable(list) {
  if (!list.length) return '<p class="muted">Sin actividad.</p>';
  const cls = { info: 'info', warn: 'warn', error: 'danger' };
  return `<div class="table-wrap"><table>${list
    .map((l) => `<tr><td style="white-space:nowrap">${fmtDateTime(l.created_at)}</td><td><span class="badge ${cls[l.level] || 'gray'}">${l.level}</span></td><td>${esc(l.message)}</td></tr>`)
    .join('')}</table></div>`;
}

start();
