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
    $('#version').textContent = `Versión ${me.version}`;
  } catch {
    showLogin();
    return;
  }
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  const params = new URLSearchParams(location.search);
  const err = params.get('error');
  const tnCode = params.get('tn_code');
  if (err || tnCode) history.replaceState(null, '', location.pathname + (tnCode ? '#config?tab=tn' : location.hash));
  if (err) toast(err, 'error');
  if (tnCode) {
    const r = await act(() => adminApi('/api/admin/integrations/tiendanube/exchange', { method: 'POST', body: { code: tnCode } }));
    if (r) toast(`Tienda Nube conectada (tienda ${r.storeId})`);
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
      <div class="card stat"><div class="label">Cobrado hoy</div><div class="value">${fmtMoney(d.cashToday.total)}</div></div>
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

/**
 * Selector de día y horario que muestra solo lo disponible.
 * source: { appointmentId } para reprogramar, o { serviceId } para un turno nuevo.
 * onChange({ date, time }) se llama al elegir (time = null al cambiar de día).
 */
async function slotPicker(container, source, { date: initialDate = null, onChange = () => {} } = {}) {
  const qs = new URLSearchParams(source).toString();
  container.innerHTML = '<p class="muted">Buscando días disponibles…</p>';
  let days;
  try {
    ({ days } = await adminApi(`/api/admin/availability?${qs}`));
  } catch (err) {
    container.innerHTML = `<div class="alert danger">${esc(err.message)}</div>`;
    return;
  }
  if (!days.length) {
    container.innerHTML = '<p class="muted">No hay días de atención configurados. Revisá Configuración → Horarios.</p>';
    return;
  }
  container.innerHTML = `
    <div class="days">${days
      .map((d) => {
        const dt = new Date(`${d.date}T12:00:00`);
        return `<button type="button" class="day" data-date="${d.date}" ${d.free ? '' : 'disabled title="Sin horarios libres"'}>
          <small>${dt.toLocaleDateString('es-AR', { weekday: 'short' })}</small><b>${dt.getDate()}</b>
          <small>${dt.toLocaleDateString('es-AR', { month: 'short' })}</small>
          <small class="free">${d.free ? `${d.free} libres` : 'Completo'}</small></button>`;
      })
      .join('')}</div>
    <p class="muted picker-msg" style="margin:0.6rem 0 0">Elegí un día.</p>
    <div class="slots picker-slots"></div>`;
  const msg = $('.picker-msg', container);
  const grid = $('.picker-slots', container);
  const selectDay = async (date) => {
    $$('.day', container).forEach((b) => b.classList.toggle('selected', b.dataset.date === date));
    onChange({ date, time: null });
    grid.innerHTML = '';
    msg.textContent = 'Buscando horarios…';
    msg.classList.remove('hidden');
    const r = await act(() => adminApi(`/api/admin/availability?${qs}&date=${date}`));
    if (!r) return;
    if (!r.slots.length) {
      msg.textContent = 'No quedan horarios libres ese día.';
      return;
    }
    msg.textContent = `${fmtDate(date)}: elegí el horario.`;
    grid.innerHTML = r.slots.map((t) => `<button type="button" class="slot" data-time="${t}">${t}</button>`).join('');
    $$('.slot', grid).forEach(
      (b) =>
        (b.onclick = () => {
          $$('.slot', grid).forEach((x) => x.classList.toggle('selected', x === b));
          onChange({ date, time: b.dataset.time });
        })
    );
  };
  $$('.day', container).forEach((b) => (b.onclick = () => selectDay(b.dataset.date)));
  const first = days.find((d) => d.date === initialDate && d.free) || days.find((d) => d.free);
  if (first) {
    selectDay(first.date);
    const btn = $(`.day[data-date="${first.date}"]`, container);
    if (btn) btn.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}

function newAppointmentModal(prefill = {}) {
  const services = app.services.filter((x) => x.active);
  const m = modal(`
    <h2>Nuevo turno</h2>
    <form id="f">
      <label>Servicio<select name="serviceId" required>${services.map((x) => `<option value="${x.id}">${esc(x.name)} (${x.duration_min} min - ${fmtMoney(x.price)})</option>`).join('')}</select></label>
      <label style="margin-bottom:0.3em">Día y horario</label>
      <div id="picker" style="margin-bottom:0.6rem"></div>
      <div id="picked" class="alert info hidden" style="padding:0.5em 0.8em"></div>
      <details style="margin-bottom:0.8rem"><summary class="muted">Cargar un horario a mano (sobreturno / fuera de horario)</summary>
        <div class="grid cols-2" style="margin-top:0.5rem">
          <label>Fecha<input type="date" name="mdate" /></label>
          <label>Hora<input type="time" name="mtime" step="300" /></label>
        </div>
        <label class="check"><input type="checkbox" name="force" /> Usar este horario aunque se superponga</label>
      </details>
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
      <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button>Guardar turno</button></div>
    </form>`);
  const f = $('#f', m);
  if (prefill.client) {
    f.name.value = prefill.client.name || '';
    f.phone.value = prefill.client.phone || '';
    f.email.value = prefill.client.email || '';
  }
  const fillPrices = () => {
    const svc = services.find((x) => x.id === Number(f.serviceId.value));
    if (svc) {
      f.price.value = svc.price;
      f.depositAmount.value = svc.deposit_amount;
    }
  };
  let pick = { date: null, time: null };
  const showPick = () => {
    $('#picked', m).classList.toggle('hidden', !pick.time);
    if (pick.time) $('#picked', m).textContent = `Turno: ${fmtDate(pick.date)} a las ${pick.time} hs`;
  };
  const loadPicker = () => {
    pick = { date: null, time: null };
    showPick();
    slotPicker($('#picker', m), { serviceId: f.serviceId.value }, {
      date: pick.date || prefill.date || app.agenda.from,
      onChange: (p) => ((pick = p), showPick()),
    });
  };
  f.serviceId.onchange = () => (fillPrices(), loadPicker());
  fillPrices();
  loadPicker();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = formData(f);
    const manual = f.mdate.value && f.mtime.value;
    if (manual) {
      body.date = f.mdate.value;
      body.time = f.mtime.value;
      body.force = f.force.checked;
    } else if (pick.time) {
      body.date = pick.date;
      body.time = pick.time;
    } else {
      return toast('Elegí un día y un horario disponible', 'error');
    }
    delete body.mdate;
    delete body.mtime;
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
      <p class="muted" style="margin-top:0">Turno actual: ${fmtDate(a.date)} a las ${a.start_time} hs. Se muestran solo los días y horarios libres.</p>
      <div id="mv-picker"></div>
      <div id="mv-picked" class="alert info hidden" style="margin-top:0.8rem;padding:0.5em 0.8em"></div>
      <details style="margin-top:0.6rem"><summary class="muted">Cargar un horario a mano (sobreturno / fuera de horario)</summary>
        <div class="grid cols-2" style="margin-top:0.5rem"><label>Fecha<input type="date" name="mdate" /></label>
        <label>Hora<input type="time" name="mtime" step="300" /></label></div>
        <label class="check"><input type="checkbox" name="force" /> Usar este horario aunque se superponga</label>
      </details>
      <div class="row end"><button id="mv-save" disabled>Guardar nuevo horario</button></div></form>`;
    const form = $('#mvf', m);
    let pick = { date: null, time: null };
    const update = () => {
      const manual = form.mdate.value && form.mtime.value;
      $('#mv-save', m).disabled = !(pick.time || manual);
      $('#mv-picked', m).classList.toggle('hidden', !pick.time || manual);
      if (pick.time) $('#mv-picked', m).textContent = `Nuevo horario: ${fmtDate(pick.date)} a las ${pick.time} hs`;
    };
    form.oninput = update;
    slotPicker($('#mv-picker', m), { appointmentId: id }, { date: a.date, onChange: (p) => ((pick = p), update()) });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const manual = form.mdate.value && form.mtime.value;
      const body = manual ? { date: form.mdate.value, time: form.mtime.value, force: form.force.checked } : { date: pick.date, time: pick.time };
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
  const [data, products, services] = await Promise.all([adminApi('/api/admin/cash'), adminApi('/api/admin/products'), loadServices()]);
  const tab = app.query.get('tab') || 'cobrar';
  const s = data.session;
  const t = data.today;
  $('#main').innerHTML = `
    <div class="page-head"><h1>Caja</h1>
      <div class="row"><button class="secondary" id="mov">Ingreso / egreso</button><button class="secondary" id="close">Arqueo</button></div></div>
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Cobrado hoy</div><div class="value">${fmtMoney(t.total)}</div></div>
      <div class="card stat"><div class="label">Efectivo en caja</div><div class="value">${fmtMoney(s.expectedCash)}</div><small class="muted">desde el último arqueo</small></div>
      <div class="card stat"><div class="label">Mercado Pago hoy</div><div class="value">${fmtMoney(t.byMethod.mercadopago)}</div></div>
      <div class="card stat"><div class="label">Tarjetas / transf. hoy</div><div class="value">${fmtMoney((t.byMethod.debito || 0) + (t.byMethod.credito || 0) + (t.byMethod.transferencia || 0))}</div></div>
    </div>
    ${data.pendingSales.length ? `<div class="alert warn">${data.pendingSales.length} cobro(s) con Mercado Pago esperando el pago. <a href="#caja?tab=ventas">Ver</a></div>` : ''}
    <div class="tabs">
      ${[['cobrar', 'Cobrar'], ['ventas', 'Ventas'], ['movimientos', 'Movimientos'], ['historial', 'Arqueos']]
        .map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`)
        .join('')}
    </div>
    <div id="tab"></div>`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => (location.hash = `caja?tab=${b.dataset.tab}`)));
  $('#mov').onclick = () => cashMovementModal();
  $('#close').onclick = () => closeCashModal(s);
  if (tab === 'cobrar') renderPos(products, services);
  if (tab === 'movimientos') $('#tab').innerHTML = `<div class="card"><h2>Movimientos desde el último arqueo</h2>${movementsTable(data.movements)}</div>`;
  if (tab === 'ventas') renderSales(data);
  if (tab === 'historial') renderCashHistory();
};

// Buscador único: productos, servicios y turnos de hoy con saldo (por nombre de la clienta).
function renderPos(products, services) {
  app.saleClient = app.saleClient || null;
  $('#tab').innerHTML = `
    <div class="pos">
      <div class="card">
        <div class="search-box">
          <input id="psearch" placeholder="Buscá un producto, un servicio o la clienta con turno hoy…" autocomplete="off" />
          <div id="presults" class="results hidden"></div>
        </div>
        <div class="row" style="margin-top:0.6rem"><button class="link" id="free">+ Otro concepto (importe libre)</button></div>
        <div id="today-appts" style="margin-top:1rem"></div>
      </div>
      <div class="card">
        <h2>Venta</h2>
        <div id="cart"></div>
        <div id="client-box"></div>
        <div class="grid cols-2" style="margin-top:0.8rem">
          <label>Descuento<input id="discount" type="number" step="0.01" min="0" value="0" /></label>
          <label>Medio de pago<select id="method">${methodOptions()}<option value="mp_link">Mercado Pago (link / QR)</option></select></label>
        </div>
        <div class="summary-line total"><span>Total</span><span id="total">$ 0</span></div>
        <label class="check" style="margin-top:0.6rem"><input type="checkbox" id="autoprint" /> Imprimir ticket al cobrar</label>
        <button id="pay" style="width:100%;margin-top:0.4rem">Cobrar</button>
      </div>
    </div>`;
  try {
    $('#autoprint').checked = localStorage.getItem('autoprint') === '1';
  } catch {
    // sin almacenamiento local
  }
  $('#autoprint').onchange = (e) => {
    try {
      localStorage.setItem('autoprint', e.target.checked ? '1' : '0');
    } catch {
      // sin almacenamiento local
    }
  };

  let todayAppts = [];
  const box = $('#presults');
  const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let options = [];
  let active = 0;
  const renderResults = () => {
    const q = norm($('#psearch').value.trim());
    if (!q) {
      box.classList.add('hidden');
      return;
    }
    const words = q.split(/\s+/);
    const match = (text) => words.every((w) => norm(text).includes(w));
    options = [
      ...todayAppts.filter((a) => match(`${a.client_name} ${a.service_name}`)).map((a) => ({ kind: 'appt', a })),
      ...services.filter((x) => x.active && match(x.name)).map((x) => ({ kind: 'svc', x })),
      ...products.filter((p) => match(`${p.name} ${p.sku || ''} ${p.brand || ''}`)).map((p) => ({ kind: 'prod', p })),
    ].slice(0, 12);
    active = 0;
    box.innerHTML = options.length
      ? options
          .map((o, i) => {
            if (o.kind === 'appt')
              return `<button class="result" data-i="${i}"><span class="badge info">Turno hoy</span><span class="grow"><b>${esc(o.a.client_name)}</b> · ${esc(o.a.service_name)} ${o.a.start_time}</span><b>${fmtMoney(o.a.balance)}</b></button>`;
            if (o.kind === 'svc') return `<button class="result" data-i="${i}"><span class="badge">Servicio</span><span class="grow">${esc(o.x.name)}</span><b>${fmtMoney(o.x.price)}</b></button>`;
            const p = o.p;
            return `<button class="result" data-i="${i}">${p.thumb ? `<img src="${esc(p.thumb)}" alt="" class="thumb sm" />` : '<span class="badge gray">Producto</span>'}
              <span class="grow">${esc(p.name)} <small class="muted">${p.sku ? `${esc(p.sku)} · ` : ''}stock ${p.stock}</small></span>
              <b>${p.effective_price < p.price ? `<s class="muted">${fmtMoney(p.price)}</s> ` : ''}${fmtMoney(p.effective_price)}</b></button>`;
          })
          .join('')
      : '<p class="muted" style="margin:0.6rem">No se encontró nada con ese nombre.</p>';
    box.classList.remove('hidden');
    highlight();
    $$('.result', box).forEach((b) => (b.onclick = () => pick(options[Number(b.dataset.i)])));
  };
  const highlight = () => $$('.result', box).forEach((b, i) => b.classList.toggle('active', i === active));
  const pick = (o) => {
    if (!o) return;
    if (o.kind === 'appt') addAppointmentLine(o.a);
    else if (o.kind === 'svc') app.cart.push({ serviceId: o.x.id, description: o.x.name, quantity: 1, unitPrice: o.x.price });
    else {
      const line = app.cart.find((l) => l.productId === o.p.id);
      if (line) line.quantity++;
      else app.cart.push({ productId: o.p.id, description: o.p.name, quantity: 1, unitPrice: o.p.effective_price, stock: o.p.stock });
      if (o.p.stock <= 0) toast(`Atención: "${o.p.name}" no tiene stock cargado`, 'error');
    }
    $('#psearch').value = '';
    box.classList.add('hidden');
    renderCart();
    $('#psearch').focus();
  };
  $('#psearch').oninput = renderResults;
  $('#psearch').onkeydown = (e) => {
    if (box.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') active = Math.min(active + 1, options.length - 1);
    else if (e.key === 'ArrowUp') active = Math.max(active - 1, 0);
    else if (e.key === 'Enter') {
      e.preventDefault();
      return pick(options[active]);
    } else if (e.key === 'Escape') return box.classList.add('hidden');
    else return;
    e.preventDefault();
    highlight();
  };
  $('#free').onclick = () => {
    app.cart.push({ description: '', quantity: 1, unitPrice: 0, free: true });
    renderCart();
  };
  adminApi(`/api/admin/appointments?from=${today()}&to=${today()}`).then((list) => {
    todayAppts = list.filter((a) => a.balance > 0 && ['confirmed', 'pending_payment'].includes(a.status));
    $('#today-appts').innerHTML = todayAppts.length
      ? `<small class="muted">Turnos de hoy con saldo: </small>${todayAppts
          .map((a) => `<button class="secondary small" data-ap="${a.id}" style="margin:0 0.3rem 0.3rem 0">${a.start_time} ${esc(a.client_name)} · ${fmtMoney(a.balance)}</button>`)
          .join('')}`
      : '';
    $$('[data-ap]').forEach((b) => (b.onclick = () => addAppointmentLine(todayAppts.find((x) => x.id === Number(b.dataset.ap)))));
  });
  $('#discount').oninput = renderTotals;
  $('#pay').onclick = paySale;
  renderCart();
  $('#psearch').focus();
}

function addAppointmentLine(a) {
  if (!app.cart.some((l) => l.appointmentId === a.id)) {
    app.cart.push({ appointmentId: a.id, description: `${a.service_name} - ${a.client_name} (saldo)`, quantity: 1, unitPrice: a.balance, fixedQty: true });
  }
  // La clienta del turno queda como clienta de la venta.
  if (!app.saleClient) app.saleClient = { id: a.client_id, name: a.client_name, phone: a.client_phone };
  renderCart();
}

// Selector de clienta de la venta (buscar o crear).
function renderClientBox() {
  const el = $('#client-box');
  if (!el) return;
  const c = app.saleClient;
  if (c) {
    el.innerHTML = `<div class="client-chip"><span>Clienta: <b>${esc(c.name)}</b>${c.phone ? ` <small class="muted">${esc(c.phone)}</small>` : ''}</span><button class="link" id="client-clear">cambiar</button></div>`;
    $('#client-clear').onclick = () => {
      app.saleClient = null;
      renderClientBox();
      $('#client-q').focus();
    };
    return;
  }
  el.innerHTML = `<label style="margin:0.8rem 0 0">Clienta <small class="muted">(opcional)</small>
      <div class="search-box"><input id="client-q" placeholder="Buscar por nombre o teléfono" autocomplete="off" /><div id="client-results" class="results hidden"></div></div></label>
    <button class="link" id="client-new" style="font-size:0.85rem">+ Clienta nueva</button>`;
  let t;
  const results = $('#client-results');
  $('#client-q').oninput = (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    if (!q) return results.classList.add('hidden');
    t = setTimeout(async () => {
      const list = (await adminApi(`/api/admin/clients?q=${encodeURIComponent(q)}`)).slice(0, 8);
      results.innerHTML = list.length
        ? list.map((x, i) => `<button class="result" data-ci="${i}"><span class="grow">${esc(x.name)}</span><small class="muted">${esc(x.phone || x.email || '')}</small></button>`).join('')
        : '<p class="muted" style="margin:0.6rem">No hay clientas con ese nombre.</p>';
      results.classList.remove('hidden');
      $$('[data-ci]', results).forEach(
        (b) =>
          (b.onclick = () => {
            app.saleClient = list[Number(b.dataset.ci)];
            renderClientBox();
          })
      );
    }, 250);
  };
  $('#client-new').onclick = () =>
    clientModal(null, (saved) => {
      app.saleClient = saved;
      renderClientBox();
    });
}

function renderCart() {
  const el = $('#cart');
  if (!el) return;
  if (!app.cart.length) {
    el.innerHTML = '<p class="muted">Buscá y agregá productos o servicios.</p>';
  } else {
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
  }
  renderClientBox();
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
  const autoprint = $('#autoprint').checked;
  const items = app.cart.map((l) => {
    if (l.productId) return { productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice };
    if (l.appointmentId) return { appointmentId: l.appointmentId, amount: l.unitPrice };
    if (l.serviceId) return { serviceId: l.serviceId, quantity: l.quantity, unitPrice: l.unitPrice };
    return { description: l.description, quantity: l.quantity, unitPrice: l.unitPrice };
  });
  $('#pay').disabled = true;
  const r = await act(() =>
    adminApi('/api/admin/sales', { method: 'POST', body: { items, discount: $('#discount').value, method, clientId: app.saleClient ? app.saleClient.id : null } })
  );
  $('#pay').disabled = false;
  if (!r) return;
  app.cart = [];
  app.saleClient = null;
  route();
  if (r.init_point) return showPaymentQr(r.sale, r);
  if (autoprint) printTicket(r.sale.id);
  saleDoneModal(r.sale);
}

function saleDoneModal(sale) {
  const m = modal(`<div style="text-align:center">
      <h2>Venta #${sale.id} cobrada</h2>
      <p style="font-size:1.6rem;font-weight:700;margin:0.4rem 0">${fmtMoney(sale.total)}</p>
      <p class="muted">${esc(METHOD_LABELS[sale.payment_method] || sale.payment_method)}${sale.client_name ? ` · ${esc(sale.client_name)}` : ''}</p>
    </div>
    <div class="actions" style="justify-content:center"><button class="secondary" id="print">Imprimir ticket</button><button data-close>Nueva venta</button></div>`);
  $('#print', m).onclick = () => printTicket(sale.id);
}

// Ticket no fiscal para impresora térmica (58 u 80 mm) o impresora común.
async function printTicket(saleId) {
  const [sale, cfg] = await Promise.all([adminApi(`/api/admin/sales/${saleId}`), app.ticketCfg || adminApi('/api/admin/settings')]);
  app.ticketCfg = cfg;
  const width = Number(cfg.ticket_width) === 58 ? 58 : 80;
  const money = (n) => fmtMoney(n).replace(/\s/g, ' ');
  const when = new Date(`${String(sale.paid_at || sale.created_at).replace(' ', 'T')}Z`).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ticket ${sale.id}</title><style>
    @page { size: ${width}mm auto; margin: 0; }
    * { box-sizing: border-box; }
    body { width: ${width}mm; margin: 0; padding: 4mm 3mm; font: ${width === 58 ? 11 : 12}px/1.35 'Courier New', monospace; color: #000; }
    .c { text-align: center; } .b { font-weight: bold; } .big { font-size: 1.25em; }
    hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
    table { width: 100%; border-collapse: collapse; } td { vertical-align: top; padding: 0.4mm 0; } td.r { text-align: right; white-space: nowrap; padding-left: 2mm; }
    .small { font-size: 0.9em; }
  </style></head><body>
    <div class="c b big">${esc(cfg.business_name || '')}</div>
    ${cfg.business_address ? `<div class="c small">${esc(cfg.business_address)}</div>` : ''}
    ${cfg.business_phone ? `<div class="c small">Tel: ${esc(cfg.business_phone)}</div>` : ''}
    <hr>
    <div>Ticket N° ${String(sale.id).padStart(6, '0')}</div>
    <div>${when}</div>
    ${sale.client_name ? `<div>Clienta: ${esc(sale.client_name)}</div>` : ''}
    <hr>
    <table>${sale.items
      .map(
        (i) => `<tr><td colspan="2">${esc(i.description)}</td></tr>
        <tr><td class="small">${i.quantity} x ${money(i.unit_price)}</td><td class="r">${money(i.subtotal)}</td></tr>`
      )
      .join('')}</table>
    <hr>
    <table>
      ${sale.discount ? `<tr><td>Subtotal</td><td class="r">${money(sale.subtotal)}</td></tr><tr><td>Descuento</td><td class="r">-${money(sale.discount)}</td></tr>` : ''}
      <tr class="b big"><td>TOTAL</td><td class="r">${money(sale.total)}</td></tr>
      <tr><td>Pago</td><td class="r">${esc(METHOD_LABELS[sale.payment_method] || sale.payment_method)}</td></tr>
    </table>
    <hr>
    ${cfg.ticket_footer ? `<div class="c">${esc(cfg.ticket_footer)}</div>` : ''}
    <div class="c small" style="margin-top:2mm">Comprobante no válido como factura</div>
  </body></html>`;
  let frame = $('#ticket-frame');
  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = 'ticket-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(frame);
  }
  frame.onload = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  };
  frame.srcdoc = html;
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
      $('#qr-status', m).innerHTML = '¡Pago acreditado! <button class="small" id="qr-print">Imprimir ticket</button>';
      $('#qr-print', m).onclick = () => printTicket(sale.id);
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
    <tr><th>#</th><th>Fecha</th><th>Clienta</th><th>Detalle</th><th>Medio</th><th class="num">Total</th><th>Estado</th><th></th></tr>
    ${list
      .map(
        (s) => `<tr><td>${s.id}</td><td>${fmtDateTime(s.created_at)}</td><td>${esc(s.client_name || '-')}</td><td>${esc(s.detail || '')}</td>
        <td>${METHOD_LABELS[s.payment_method] || s.payment_method}</td><td class="num">${fmtMoney(s.total)}</td><td>${badge[s.status] || s.status}</td>
        <td style="white-space:nowrap">
          ${s.status === 'paid' ? `<button class="secondary small" data-ticket="${s.id}">Ticket</button>` : ''}
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
    <div class="card"><h2>Últimas ventas</h2>${salesTable(data.sales)}</div>`;
  bindSaleActions();
}

function bindSaleActions() {
  $$('[data-ticket]').forEach((b) => (b.onclick = () => printTicket(Number(b.dataset.ticket))));
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
      : '<p class="muted">Todavía no hiciste arqueos.</p>'
  }</div>`;
  $$('[data-sess]', el).forEach(
    (b) =>
      (b.onclick = async () => {
        const d = await adminApi(`/api/admin/cash/sessions/${b.dataset.sess}`);
        modal(
          `<h2>Arqueo #${d.session.id}</h2>
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

async function cashMovementModal() {
  if (!app.expenseCategories) app.expenseCategories = await adminApi('/api/admin/expenses/categories');
  const m = modal(`<h2>Ingreso / egreso de caja</h2><form id="f">
    <div class="grid cols-2"><label>Tipo<select name="type"><option value="expense">Egreso (pago, retiro)</option><option value="income">Ingreso</option></select></label>
    <label>Medio<select name="method">${methodOptions()}</select></label></div>
    <label id="cat-wrap">Categoría del gasto<select name="category">${(app.expenseCategories || []).map((c) => `<option>${esc(c)}</option>`).join('')}
      <option value="retiro">Retiro de dinero del dueño (no es gasto)</option></select></label>
    <label>Importe<input name="amount" type="number" step="0.01" min="0" required /></label>
    <label>Descripción<input name="description" required placeholder="Ej: pago de limpieza, cambio" /></label>
    <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button>Registrar</button></div></form>`);
  $('#f', m).type.onchange = (e) => $('#cat-wrap', m).classList.toggle('hidden', e.target.value !== 'expense');
  $('#f', m).onsubmit = async (e) => {
    e.preventDefault();
    if (await act(() => adminApi('/api/admin/cash/movements', { method: 'POST', body: formData(e.target) }), 'Movimiento registrado')) {
      m.remove();
      route();
    }
  };
}

function closeCashModal(s) {
  const m = modal(`<h2>Arqueo de caja</h2>
    <p class="muted">Contá el efectivo. Se registra la diferencia y la caja sigue abierta con lo que contaste.</p>
    <table>${Object.entries(s.byMethod).map(([k, v]) => `<tr><td>${METHOD_LABELS[k]}</td><td class="num">${fmtMoney(v)}</td></tr>`).join('')}
    <tr><td><b>Efectivo esperado en caja</b> <small class="muted">(inicial + movimientos en efectivo)</small></td><td class="num"><b>${fmtMoney(s.expectedCash)}</b></td></tr></table>
    <form id="f" style="margin-top:1rem"><label>Efectivo contado<input name="countedAmount" type="number" step="0.01" min="0" required value="${s.expectedCash}" /></label>
    <div id="diff" class="muted"></div>
    <label>Notas<textarea name="notes" rows="2"></textarea></label>
    <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button>Registrar arqueo</button></div></form>`);
  const f = $('#f', m);
  f.countedAmount.oninput = () => {
    const d = Number(f.countedAmount.value) - s.expectedCash;
    $('#diff', m).textContent = Math.abs(d) < 0.01 ? 'Sin diferencias' : `Diferencia: ${fmtMoney(d)}`;
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const r = await act(() => adminApi('/api/admin/cash/close', { method: 'POST', body: formData(f) }), 'Arqueo registrado');
    if (r) {
      m.remove();
      route();
    }
  };
}

// ---------- Resultados ----------

app.res = { preset: 'month', from: '', to: '' };

function periodFor(preset) {
  const t = today();
  const [y, mo] = t.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (preset === 'month') return [`${y}-${pad(mo)}-01`, t];
  if (preset === 'prev') {
    const py = mo === 1 ? y - 1 : y;
    const pm = mo === 1 ? 12 : mo - 1;
    return [`${py}-${pad(pm)}-01`, `${py}-${pad(pm)}-${pad(lastDay(py, pm))}`];
  }
  if (preset === '30') return [addDays(t, -29), t];
  if (preset === 'year') return [`${y}-01-01`, t];
  return [app.res.from || `${y}-${pad(mo)}-01`, app.res.to || t];
}

function periodControls() {
  const r = app.res;
  return `<div class="card row">
    <select id="preset" style="width:auto">
      ${[['month', 'Este mes'], ['prev', 'Mes anterior'], ['30', 'Últimos 30 días'], ['year', 'Este año'], ['custom', 'Elegir fechas']]
        .map(([k, l]) => `<option value="${k}" ${r.preset === k ? 'selected' : ''}>${l}</option>`)
        .join('')}
    </select>
    <span class="row ${r.preset === 'custom' ? '' : 'hidden'}" id="custom">
      <input type="date" id="from" value="${r.from}" style="width:auto" /> a <input type="date" id="to" value="${r.to}" style="width:auto" />
    </span>
    <span class="muted" id="period-label"></span>
  </div>`;
}

function bindPeriodControls(reload) {
  $('#preset').onchange = (e) => {
    app.res.preset = e.target.value;
    if (app.res.preset === 'custom') {
      const [f, t] = periodFor('month');
      app.res.from = app.res.from || f;
      app.res.to = app.res.to || t;
    }
    reload();
  };
  if ($('#from')) $('#from').onchange = (e) => ((app.res.from = e.target.value), reload());
  if ($('#to')) $('#to').onchange = (e) => ((app.res.to = e.target.value), reload());
}

VIEWS.resultados = async () => {
  const tab = app.query.get('tab') || 'resumen';
  $('#main').innerHTML = `<div class="page-head"><h1>Resultados</h1><button id="new-exp">+ Cargar gasto</button></div>
    <div class="tabs">${[['resumen', 'Resumen'], ['gastos', 'Gastos']].map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    ${periodControls()}
    <div id="tab"><p class="muted">Calculando…</p></div>`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => (location.hash = `resultados?tab=${b.dataset.tab}`)));
  $('#new-exp').onclick = () => expenseModal(() => VIEWS.resultados());
  bindPeriodControls(() => VIEWS.resultados());
  const [from, to] = periodFor(app.res.preset);
  $('#period-label').textContent = `${fmtDate(from, { day: 'numeric', month: 'short', year: 'numeric' })} al ${fmtDate(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  if (tab === 'gastos') return renderExpenses(from, to);
  return renderResults(from, to);
};

const pct = (v) => (v === null || v === undefined ? '-' : `${String(v).replace('.', ',')}%`);

function delta(current, previous, { invert = false } = {}) {
  if (!previous) return '';
  const change = ((current - previous) / Math.abs(previous)) * 100;
  if (!Number.isFinite(change)) return '';
  const up = change >= 0;
  const good = invert ? !up : up;
  return `<small style="color:${good ? 'var(--ok)' : 'var(--danger)'}">${up ? '▲' : '▼'} ${Math.abs(Math.round(change))}%</small> <small class="muted">vs. período anterior</small>`;
}

async function renderResults(from, to) {
  const r = await adminApi(`/api/admin/reports/results?from=${from}&to=${to}`);
  const t = r.totals;
  const p = r.previous;
  const tile = (label, value, sub, d) => `<div class="card stat"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div><small class="muted">${sub}</small></div>` : ''}<div>${d}</div></div>`;
  // Sin costo cargado el margen no es real: no se muestra.
  const marginCell = (m, missingCost = false) =>
    missingCost ? '<span class="muted" title="Falta cargar el costo">—</span>' : m === null ? '-' : `<span class="badge ${m < 0 ? 'danger' : m < 30 ? 'warn' : 'ok'}">${pct(m)}</span>`;
  const hasPrevious = p.revenue || p.cost || p.expenses;
  const missing = r.extra.productsWithoutCost + r.extra.servicesWithoutCost;
  $('#tab').innerHTML = `
    ${
      missing
        ? `<div class="alert warn">Hay ${r.extra.servicesWithoutCost ? `${r.extra.servicesWithoutCost} servicio(s)` : ''}${r.extra.servicesWithoutCost && r.extra.productsWithoutCost ? ' y ' : ''}${r.extra.productsWithoutCost ? `${r.extra.productsWithoutCost} producto(s)` : ''} sin costo cargado: la ganancia aparece más alta de lo real.
          Cargalo en ${r.extra.servicesWithoutCost ? '<a href="#config?tab=servicios">Configuración → Servicios</a>' : ''}${r.extra.servicesWithoutCost && r.extra.productsWithoutCost ? ' y ' : ''}${r.extra.productsWithoutCost ? '<a href="#inventario">Inventario</a>' : ''}.</div>`
        : ''
    }
    <div class="grid kpis">
      ${tile('Ingresos', fmtMoney(t.revenue), 'ventas y turnos atendidos', delta(t.revenue, p.revenue))}
      ${tile('Costo de lo vendido', fmtMoney(t.cost), 'productos + insumos de servicios', delta(t.cost, p.cost, { invert: true }))}
      ${tile('Ganancia bruta', fmtMoney(t.gross), `margen ${pct(t.grossMargin)}`, delta(t.gross, p.gross))}
      ${tile('Gastos', fmtMoney(t.expenses), 'alquiler, sueldos, servicios…', delta(t.expenses, p.expenses, { invert: true }))}
      ${tile('Ganancia neta', `<span style="color:${t.net < 0 ? 'var(--danger)' : 'inherit'}">${fmtMoney(t.net)}</span>`, `margen ${pct(t.netMargin)}`, delta(t.net, p.net))}
    </div>
    <p class="muted" style="margin:-0.4rem 0 1rem">${
      hasPrevious
        ? `Las flechas comparan con el período anterior de igual duración (${fmtDate(p.from, { day: 'numeric', month: 'short' })} al ${fmtDate(p.to, { day: 'numeric', month: 'short' })}).`
        : 'No hay datos del período anterior para comparar.'
    }</p>

    <div class="card">
      <div class="row between"><h2 style="margin:0">Ingresos y ganancia bruta ${r.groupBy === 'month' ? 'por mes' : 'por día'}</h2>
        <button class="secondary small" id="as-table">Ver como tabla</button></div>
      <div class="legend"><span><i style="background:var(--series-1)"></i>Ingresos</span><span><i style="background:var(--series-2)"></i>Ganancia bruta</span></div>
      <div id="chart" class="chart"></div>
      <div id="chart-table" class="hidden"></div>
    </div>

    <div class="grid split">
      <div class="card"><h2>Por canal</h2>
        <div class="table-wrap"><table><tr><th>Canal</th><th class="num">Ingresos</th><th class="num">Costo</th><th class="num">Ganancia</th><th class="num">Margen</th></tr>
        ${r.channels
          .filter((c) => c.revenue || c.cost)
          .map((c) => `<tr><td>${esc(c.label)}</td><td class="num">${fmtMoney(c.revenue)}</td><td class="num">${fmtMoney(c.cost)}</td><td class="num">${fmtMoney(c.gross)}</td><td class="num">${marginCell(c.margin)}</td></tr>`)
          .join('') || '<tr><td colspan="5" class="muted">Sin ventas en el período.</td></tr>'}
        </table></div>
      </div>
      <div class="card"><h2>Otros datos</h2>
        <div class="summary-line"><span>Turnos atendidos</span><b>${r.extra.appointmentsAttended}</b></div>
        <div class="summary-line"><span>Ventas (local + web)</span><b>${r.extra.salesCount}</b></div>
        <div class="summary-line"><span>Ticket promedio</span><b>${fmtMoney(r.extra.avgTicket)}</b></div>
        <div class="summary-line"><span>Ventas en la tienda online</span><b>${r.extra.webOrders}</b></div>
        ${r.extra.advanceDeposits ? `<div class="summary-line"><span>Señas cobradas de turnos futuros <small class="muted">(se cuentan cuando se atiende el turno)</small></span><b>${fmtMoney(r.extra.advanceDeposits)}</b></div>` : ''}
        ${r.extra.retainedDeposits ? `<div class="summary-line"><span>Señas retenidas por ausencias o cancelaciones</span><b>${fmtMoney(r.extra.retainedDeposits)}</b></div>` : ''}
        ${r.extra.shippingCharged ? `<div class="summary-line"><span>Envíos cobrados a clientes <small class="muted">(no se cuentan como ingreso)</small></span><b>${fmtMoney(r.extra.shippingCharged)}</b></div>` : ''}
      </div>
    </div>

    <div class="card"><h2>Servicios</h2>
      ${
        r.services.length
          ? `<div class="table-wrap"><table><tr><th>Servicio</th><th class="num">Sesiones</th><th class="num">Ingresos</th><th class="num">Costo insumos</th><th class="num">Ganancia</th><th class="num">Margen</th></tr>
          ${r.services
            .map(
              (s) => `<tr><td>${esc(s.name)} ${s.missingCost ? '<span class="badge warn">sin costo</span>' : ''}</td><td class="num">${s.units}</td><td class="num">${fmtMoney(s.revenue)}</td>
              <td class="num">${fmtMoney(s.cost)}</td><td class="num">${fmtMoney(s.gross)}</td><td class="num">${marginCell(s.margin, s.missingCost)}</td></tr>`
            )
            .join('')}</table></div>
          <p class="muted" style="margin-bottom:0">Cada turno atendido se cuenta por su precio de venta (seña + saldo, con descuentos) y su costo de insumos, el día del turno.
          Si se marcó atendido sin cobrar el saldo en la caja, se toma el precio del servicio. Las señas de turnos futuros todavía no son ingreso.</p>`
          : '<p class="muted">Sin servicios en el período.</p>'
      }
    </div>

    <div class="card"><h2>Productos</h2>
      ${
        r.products.length
          ? `<div class="table-wrap"><table><tr><th>Producto</th><th class="num">Unidades</th><th class="num">Ingresos</th><th class="num">Costo</th><th class="num">Ganancia</th><th class="num">Margen</th></tr>
          ${r.products
            .map(
              (x) => `<tr><td>${esc(x.name)} ${x.missingCost ? '<span class="badge warn">sin costo</span>' : ''}</td>
              <td class="num">${x.units}${x.localUnits && x.webUnits ? `<br><small class="muted">${x.localUnits} local · ${x.webUnits} web</small>` : x.webUnits ? '<br><small class="muted">web</small>' : ''}</td>
              <td class="num">${fmtMoney(x.revenue)}</td><td class="num">${x.missingCost && !x.cost ? '<span class="muted">sin cargar</span>' : fmtMoney(x.cost)}</td><td class="num">${fmtMoney(x.gross)}</td><td class="num">${marginCell(x.margin, x.missingCost)}</td></tr>`
            )
            .join('')}</table></div>`
          : '<p class="muted">Sin productos vendidos en el período.</p>'
      }
    </div>

    <div class="card"><div class="row between"><h2 style="margin:0">Gastos por categoría</h2><a href="#resultados?tab=gastos">Ver detalle</a></div>
      ${
        r.expensesByCategory.length
          ? `<div class="table-wrap"><table><tr><th>Categoría</th><th class="num">Importe</th><th class="num">% de los gastos</th></tr>
          ${r.expensesByCategory
            .map((e) => `<tr><td>${esc(e.category)}</td><td class="num">${fmtMoney(e.amount)}</td><td class="num">${t.expenses ? Math.round((e.amount / t.expenses) * 100) : 0}%</td></tr>`)
            .join('')}</table></div>`
          : '<p class="muted">No hay gastos cargados en el período. Cargalos con "+ Cargar gasto" para ver la ganancia neta real.</p>'
      }
    </div>`;
  drawResultsChart($('#chart'), r.series, r.groupBy);
  $('#as-table').onclick = () => {
    const tableEl = $('#chart-table');
    const showing = !tableEl.classList.contains('hidden');
    tableEl.classList.toggle('hidden', showing);
    $('#chart').classList.toggle('hidden', !showing);
    $('#as-table').textContent = showing ? 'Ver como tabla' : 'Ver gráfico';
    if (!showing) {
      tableEl.innerHTML = `<div class="table-wrap"><table><tr><th>${r.groupBy === 'month' ? 'Mes' : 'Día'}</th><th class="num">Ingresos</th><th class="num">Ganancia bruta</th><th class="num">Ganancia neta</th></tr>
        ${r.series.map((s) => `<tr><td>${esc(bucketLabel(s.key, r.groupBy, true))}</td><td class="num">${fmtMoney(s.revenue)}</td><td class="num">${fmtMoney(s.gross)}</td><td class="num">${fmtMoney(s.net)}</td></tr>`).join('')}</table></div>`;
    }
  };
}

function bucketLabel(key, groupBy, long = false) {
  if (groupBy === 'month') {
    const s = new Date(`${key}-15T12:00:00`).toLocaleDateString('es-AR', { month: long ? 'long' : 'short', year: long ? 'numeric' : '2-digit' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return long ? fmtDate(key, { weekday: 'short', day: 'numeric', month: 'short' }) : String(Number(key.slice(8)));
}

const compactMoney = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',')}M`;
  if (a >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
};

// Barras agrupadas (Ingresos / Ganancia bruta) en SVG, con tooltip por grupo.
function drawResultsChart(el, series, groupBy) {
  if (!series.some((s) => s.revenue || s.gross)) {
    el.innerHTML = '<p class="muted">Sin movimientos en el período.</p>';
    return;
  }
  const W = 900;
  const H = 260;
  const pad = { l: 56, r: 12, t: 12, b: 28 };
  const values = series.flatMap((s) => [s.revenue, s.gross]);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const niceStep = (range) => {
    const raw = range / 4;
    const mag = 10 ** Math.floor(Math.log10(raw || 1));
    return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  };
  const step = niceStep(max - min || 1);
  const top = Math.ceil(max / step) * step || step;
  const bottom = Math.floor(min / step) * step;
  const y = (v) => pad.t + ((top - v) / (top - bottom)) * (H - pad.t - pad.b);
  const plotW = W - pad.l - pad.r;
  const slot = plotW / series.length;
  const barW = Math.max(2, Math.min(18, (slot - 6) / 2));
  const ticks = [];
  for (let v = bottom; v <= top + 1e-6; v += step) ticks.push(v);
  const labelEvery = Math.ceil(series.length / 16);
  const bar = (x, v, color) => {
    const y0 = y(0);
    const y1 = y(v);
    const h = Math.max(Math.abs(y1 - y0), v ? 1 : 0);
    return `<rect x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}" />`;
  };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ingresos y ganancia bruta">
    ${ticks.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'axis' : 'grid'}" /><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end" class="tick">${compactMoney(v)}</text>`).join('')}
    ${series
      .map((s, i) => {
        const cx = pad.l + slot * i + slot / 2;
        return `<g class="grp" data-i="${i}">
          <rect class="hit" x="${pad.l + slot * i}" y="${pad.t}" width="${slot}" height="${H - pad.t - pad.b}" />
          ${bar(cx - barW - 1, s.revenue, 'var(--series-1)')}${bar(cx + 1, s.gross, 'var(--series-2)')}
          ${i % labelEvery === 0 ? `<text x="${cx}" y="${H - 8}" text-anchor="middle" class="tick">${esc(bucketLabel(s.key, groupBy))}</text>` : ''}
        </g>`;
      })
      .join('')}
  </svg><div class="chart-tip hidden"></div>`;
  const tip = $('.chart-tip', el);
  $$('.grp', el).forEach((g) => {
    const show = () => {
      const s = series[Number(g.dataset.i)];
      $$('.grp', el).forEach((x) => x.classList.toggle('dim', x !== g));
      tip.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'tip-title';
      title.textContent = bucketLabel(s.key, groupBy, true);
      tip.appendChild(title);
      for (const [label, value, color] of [['Ingresos', s.revenue, 'var(--series-1)'], ['Ganancia bruta', s.gross, 'var(--series-2)'], ['Ganancia neta', s.net, null]]) {
        const row = document.createElement('div');
        row.className = 'tip-row';
        const key = document.createElement('span');
        if (color) {
          const sw = document.createElement('i');
          sw.style.background = color;
          key.appendChild(sw);
        }
        key.appendChild(document.createTextNode(label));
        const val = document.createElement('b');
        val.textContent = fmtMoney(value);
        row.append(val, key);
        tip.appendChild(row);
      }
      tip.classList.remove('hidden');
      const box = el.getBoundingClientRect();
      const gb = g.getBoundingClientRect();
      const left = gb.left - box.left + gb.width / 2;
      tip.style.left = `${Math.min(Math.max(left, 90), box.width - 90)}px`;
    };
    g.addEventListener('pointerenter', show);
    g.addEventListener('focus', show);
    g.setAttribute('tabindex', '0');
  });
  el.addEventListener('pointerleave', () => {
    tip.classList.add('hidden');
    $$('.grp', el).forEach((x) => x.classList.remove('dim'));
  });
}

async function renderExpenses(from, to) {
  const { expenses, categories } = await adminApi(`/api/admin/expenses?from=${from}&to=${to}`);
  app.expenseCategories = categories;
  const total = expenses.reduce((t, e) => t + e.amount, 0);
  $('#tab').innerHTML = `<div class="card">
    <div class="row between"><h2 style="margin:0">Gastos del período</h2><b>${fmtMoney(total)}</b></div>
    <p class="muted">La compra de mercadería no se carga acá: su costo ya se cuenta cuando se vende cada producto (cargá el costo en el Inventario).
      Los egresos de caja con categoría aparecen acá automáticamente.</p>
    ${
      expenses.length
        ? `<div class="table-wrap"><table><tr><th>Fecha</th><th>Categoría</th><th>Descripción</th><th>Medio</th><th class="num">Importe</th><th></th></tr>
        ${expenses
          .map(
            (e) => `<tr><td>${fmtDate(e.date, { day: '2-digit', month: '2-digit', year: '2-digit' })}</td><td>${esc(e.category)}</td><td>${esc(e.description || '')}</td>
            <td>${esc(METHOD_LABELS[e.payment_method] || e.payment_method || '')}${e.cash_movement_id ? ' <span class="badge info">caja</span>' : ''}</td>
            <td class="num">${fmtMoney(e.amount)}</td><td><button class="danger small" data-del="${e.id}">Borrar</button></td></tr>`
          )
          .join('')}</table></div>`
        : '<p class="muted">No hay gastos cargados en este período.</p>'
    }</div>`;
  $$('[data-del]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm('¿Borrar este gasto? Si salió de la caja, el dinero vuelve a la caja.')) return;
        if (await act(() => adminApi(`/api/admin/expenses/${b.dataset.del}`, { method: 'DELETE' }), 'Gasto borrado')) VIEWS.resultados();
      })
  );
}

async function expenseModal(onSaved) {
  if (!app.expenseCategories) app.expenseCategories = await adminApi('/api/admin/expenses/categories');
  const m = modal(`<h2>Cargar gasto</h2><form id="ef">
    <div class="grid cols-2">
      <label>Fecha<input type="date" name="date" value="${today()}" required /></label>
      <label>Categoría<select name="category">${app.expenseCategories.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
    </div>
    <label>Descripción<input name="description" placeholder="Ej: alquiler de noviembre, sueldo de Sofía, luz" /></label>
    <div class="grid cols-2">
      <label>Importe<input name="amount" type="number" min="0" step="0.01" required /></label>
      <label>Medio de pago<select name="method">${methodOptions('transferencia')}</select></label>
    </div>
    <label class="check"><input type="checkbox" name="fromCash" /> Lo pagué con plata de la caja (descuenta de la caja abierta)</label>
    <p class="muted">La compra de mercadería para vender no es un gasto: su costo se toma del Inventario cuando se vende.</p>
    <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button>Guardar gasto</button></div></form>`);
  const f = $('#ef', m);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = formData(f);
    body.fromCash = f.fromCash.checked;
    if (await act(() => adminApi('/api/admin/expenses', { method: 'POST', body }), 'Gasto cargado')) {
      m.remove();
      onSaved();
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

// ---------- Inventario ----------

app.inv = { q: '', categoryId: '', status: '' };
const MAX_PHOTOS = 3;

VIEWS.stock = async () => {
  location.hash = 'inventario';
};

VIEWS.inventario = async () => {
  const tab = app.query.get('tab') || 'articulos';
  $('#main').innerHTML = `
    <div class="page-head"><h1>Inventario</h1>
      <div class="row"><button class="secondary" id="discount">% Descuentos</button><button id="new">+ Nuevo artículo</button></div></div>
    <div class="tabs">${[['articulos', 'Artículos'], ['categorias', 'Categorías'], ['movimientos', 'Movimientos de stock']]
      .map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`)
      .join('')}</div>
    <div id="tab"><p class="muted">Cargando…</p></div>`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => (location.hash = `inventario?tab=${b.dataset.tab}`)));
  $('#new').onclick = () => articleModal();
  $('#discount').onclick = () => discountModal();
  if (tab === 'categorias') return renderCategories();
  if (tab === 'movimientos') {
    const list = await adminApi('/api/admin/stock-movements?limit=500');
    $('#tab').innerHTML = `<div class="card">${stockMovementsTable(list, true)}</div>`;
    return;
  }
  return renderArticles();
};

const categoryOptions = (tree, selected = '', { all = false } = {}) =>
  (all ? '<option value="">Todas las categorías</option>' : '') +
  tree
    .map(
      (c) =>
        `<option value="${c.id}" ${String(selected) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>` +
        c.children.map((s) => `<option value="${s.id}" ${String(selected) === String(s.id) ? 'selected' : ''}>&nbsp;&nbsp;› ${esc(s.name)}</option>`).join('')
    )
    .join('');

function priceCell(a) {
  const range = (min, max) => (min === max ? fmtMoney(min) : `${fmtMoney(min)} – ${fmtMoney(max)}`);
  if (!a.on_promo) return range(a.price_min, a.price_max);
  if (a.variants.length === 1) {
    const v = a.variants[0];
    return `<s class="muted">${fmtMoney(v.price)}</s><br><b style="color:var(--danger)">${fmtMoney(v.effective_price)}</b>`;
  }
  const n = a.variants.filter((v) => v.effective_price < v.price).length;
  return `${range(a.price_min, a.price_max)}<br><span class="badge danger">${n === a.variants.length ? 'En promoción' : `${n} en promoción`}</span>`;
}

function onlineBadge(a, connected) {
  if (!a.publish_online) return '<span class="badge gray">No se publica</span>';
  if (!connected && !a.tn_product_id) return '<span class="badge gray" title="Conectá Tienda Nube en Configuración">Tienda sin conectar</span>';
  if (a.tn_sync_status === 'error') return `<span class="badge danger" title="${esc(a.tn_sync_error || '')}">Error al publicar</span>`;
  if (a.tn_product_id) return '<span class="badge ok">Publicado</span>';
  return '<span class="badge gray">Pendiente</span>';
}

async function renderArticles() {
  const f = app.inv;
  const [tree, { articles: list, tnConnected }] = await Promise.all([
    adminApi('/api/admin/categories'),
    adminApi(`/api/admin/articles?${new URLSearchParams({ q: f.q, categoryId: f.categoryId, status: f.status })}`),
  ]);
  app.categories = tree;
  app.tnConnected = tnConnected;
  $('#tab').innerHTML = `
    <div class="card row">
      <input id="q" class="grow" placeholder="Buscar por nombre, marca o SKU" value="${esc(f.q)}" style="min-width:200px" />
      <select id="cat" style="width:auto">${categoryOptions(tree, f.categoryId, { all: true })}</select>
      <select id="st" style="width:auto">
        ${[['', 'Activos'], ['low', 'Stock bajo'], ['promo', 'En promoción'], ['inactive', 'Inactivos'], ['all', 'Todos']]
          .map(([k, l]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${l}</option>`)
          .join('')}
      </select>
    </div>
    <div class="card">${
      list.length
        ? `<div class="table-wrap"><table><tr><th></th><th>Artículo</th><th>Categoría</th><th class="num">Precio</th><th class="num">Stock</th><th>Tienda online</th><th></th></tr>
        ${list
          .map(
            (a) => `<tr style="${a.active ? '' : 'opacity:.5'}">
            <td style="width:56px">${a.thumb ? `<img src="${esc(a.thumb)}" alt="" class="thumb" />` : '<div class="thumb empty">sin foto</div>'}</td>
            <td><b>${esc(a.name)}</b>${a.brand ? ` <small class="muted">${esc(a.brand)}</small>` : ''}
              ${a.variants.length > 1 ? `<br><small class="muted">${a.variants.length} variantes: ${esc(a.variants.map((v) => v.values.join(' / ')).join(', '))}</small>` : a.variants[0] && a.variants[0].sku ? `<br><small class="muted">SKU ${esc(a.variants[0].sku)}</small>` : ''}
              ${a.active ? '' : ' <span class="badge gray">inactivo</span>'}${a.image_count ? '' : ' <span class="badge warn">falta foto</span>'}</td>
            <td><small>${esc(a.category || '-')}</small></td>
            <td class="num">${priceCell(a)}<br>${a.missing_cost ? '<span class="badge warn" title="Cargá el costo para ver la ganancia en Resultados">sin costo</span>' : a.margin !== null ? `<small class="muted">margen ${a.margin}%</small>` : ''}</td>
            <td class="num"><span class="badge ${a.stock <= 0 ? 'danger' : a.low_stock ? 'warn' : 'ok'}">${a.stock}</span></td>
            <td>${onlineBadge(a, tnConnected)}</td>
            <td style="white-space:nowrap"><button class="small" data-edit="${a.id}">Editar</button>
              <button class="secondary small" data-adj="${a.id}">Stock</button>
              <button class="secondary small" data-hist="${a.id}">Movimientos</button></td></tr>`
          )
          .join('')}</table></div>`
        : `<p class="muted">No hay artículos${f.q || f.categoryId || f.status ? ' con estos filtros' : ''}. ${
            tree.length ? 'Tocá "+ Nuevo artículo" para cargar el primero.' : 'Empezá creando las categorías en la pestaña Categorías, o importá tus productos desde Tienda Nube (Configuración).'
          }</p>`
    }</div>`;
  const reload = () => renderArticles();
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
    }, 350);
  };
  $('#cat').onchange = (e) => ((f.categoryId = e.target.value), reload());
  $('#st').onchange = (e) => ((f.status = e.target.value), reload());
  $$('[data-edit]').forEach((b) => (b.onclick = async () => articleModal(await adminApi(`/api/admin/articles/${b.dataset.edit}`))));
  $$('[data-adj]').forEach(
    (b) =>
      (b.onclick = async () => {
        const a = await adminApi(`/api/admin/articles/${b.dataset.adj}`);
        adjustModal(a);
      })
  );
  $$('[data-hist]').forEach(
    (b) =>
      (b.onclick = async () => {
        const a = list.find((x) => x.id === Number(b.dataset.hist));
        const mv = await adminApi(`/api/admin/stock-movements?articleId=${a.id}`);
        modal(`<h2>${esc(a.name)}</h2>${stockMovementsTable(mv, a.variants.length > 1)}<div class="actions"><button class="secondary" data-close>Cerrar</button></div>`, { wide: true });
      })
  );
}

function stockMovementsTable(list, withProduct = false) {
  if (!list.length) return '<p class="muted">Sin movimientos.</p>';
  return `<div class="table-wrap"><table><tr><th>Fecha</th>${withProduct ? '<th>Artículo</th>' : ''}<th>Tipo</th><th>Motivo</th><th class="num">Cantidad</th><th class="num">Stock</th><th>Usuario</th></tr>
    ${list
      .map(
        (m) => `<tr><td>${fmtDateTime(m.created_at)}</td>${withProduct ? `<td>${esc(m.product_name)}</td>` : ''}<td>${STOCK_TYPES[m.type] || m.type}</td>
        <td>${esc(m.reason || '')}</td><td class="num" style="color:${m.quantity < 0 ? 'var(--danger)' : 'var(--ok)'}">${m.quantity > 0 ? '+' : ''}${m.quantity}</td>
        <td class="num">${m.stock_after}</td><td>${esc(m.username || (m.type.startsWith('tiendanube') ? 'Tienda Nube' : ''))}</td></tr>`
      )
      .join('')}</table></div>`;
}

// Ajuste de stock: si el artículo tiene variantes se elige cuál.
function adjustModal(a) {
  const variants = a.variants;
  if (!variants.length) return toast('El artículo no tiene variantes activas', 'error');
  const m = modal(`<h2>Ajustar stock</h2><p><b>${esc(a.name)}</b></p>
    <form id="f">
      ${
        variants.length > 1
          ? `<label>Variante<select name="variant">${variants.map((v) => `<option value="${v.id}">${esc(v.values.join(' / '))} (stock ${v.stock})</option>`).join('')}</select></label>`
          : `<input type="hidden" name="variant" value="${variants[0].id}" /><p class="muted">Stock actual: <b>${variants[0].stock}</b></p>`
      }
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
    const v = variants.find((x) => x.id === Number(f.variant.value));
    const q = Number(f.quantity.value) || 0;
    const after = f.mode.value === 'set' ? q : f.mode.value === 'add' ? v.stock + q : v.stock - q;
    $('#prev', m).textContent = `Stock resultante: ${after}`;
  };
  f.oninput = preview;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const { variant, ...body } = formData(f);
    if (await act(() => adminApi(`/api/admin/products/${variant}/adjust`, { method: 'POST', body }), 'Stock actualizado')) {
      m.remove();
      if (app.view === 'inventario') renderArticles();
    }
  };
}

// Achica la foto en el navegador (máx. 1600 px, JPG) para que suba rápido.
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer la foto'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('El archivo no es una imagen válida'));
      img.onload = () => {
        const max = 1600;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Combina los valores de cada tipo de variante: [[S,M],[Rojo]] -> [[S,Rojo],[M,Rojo]]
const combinations = (lists) => lists.reduce((acc, list) => acc.flatMap((prev) => list.map((x) => [...prev, x])), [[]]);

async function articleModal(a = null) {
  const tree = app.categories && app.categories.length ? app.categories : await adminApi('/api/admin/categories');
  app.categories = tree;
  const st = {
    images: a ? a.images.map((i) => ({ id: i.id, src: i.src })) : [],
    hasVariants: a ? a.attributes.length > 0 : false,
    attributes: a && a.attributes.length ? [...a.attributes] : [''],
    variants: a
      ? a.variants.map((v) => ({ id: v.id, values: [...v.values], sku: v.sku || '', price: v.price, promo_price: v.promo_price || '', cost: v.cost ?? '', stock: v.stock, weight: v.weight && v.weight !== a.weight ? v.weight : '' }))
      : [{ values: [], sku: '', price: '', promo_price: '', stock: 0, weight: '' }],
  };
  const top = a && a.category ? a.category.id : '';
  const sub = a && a.subcategory ? a.subcategory.id : '';
  const m = modal(
    `<h2>${a ? 'Editar artículo' : 'Nuevo artículo'}</h2>
    <form id="af" novalidate>
      <h3>Fotos <small class="muted">(de 1 a ${MAX_PHOTOS}, la primera es la principal)</small></h3>
      <div class="photos" id="photos"></div>
      <input type="file" id="photo-input" accept="image/*" multiple class="hidden" />

      <h3 style="margin-top:1rem">Datos del artículo</h3>
      <div class="grid cols-2">
        <label>Nombre *<input name="name" required value="${esc(a ? a.name : '')}" placeholder="Ej: Crema hidratante post bronceado" /></label>
        <label>Marca<input name="brand" value="${esc(a && a.brand ? a.brand : '')}" list="brands" /></label>
      </div>
      <div class="grid cols-2">
        <label>Categoría * <button type="button" class="link" id="add-cat">+ nueva</button>
          <select name="category"><option value="">Elegí una categoría</option>${tree.map((c) => `<option value="${c.id}" ${String(top) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>Subcategoría <button type="button" class="link" id="add-sub">+ nueva</button><select name="subcategory"></select></label>
      </div>
      <label>Descripción<textarea name="description" rows="4" placeholder="Beneficios, modo de uso, ingredientes…">${esc(a && a.description ? a.description : '')}</textarea></label>

      <h3 style="margin-top:1rem">Precio y stock</h3>
      <label class="check"><input type="checkbox" id="has-variants" ${st.hasVariants ? 'checked' : ''} /> Este artículo tiene variantes (ej: tamaño, color, aroma)</label>
      <div id="variants-box"></div>
      <label style="max-width:220px">Avisar cuando el stock baje de<input name="minStock" type="number" min="0" step="1" value="${a && a.variants[0] ? a.variants[0].min_stock : 0}" /></label>

      <h3 style="margin-top:1rem">Envío <small class="muted">(obligatorio para publicar en la tienda: se usa para calcular el costo de envío)</small></h3>
      <div class="grid cols-4">
        <label>Peso (kg) *<input name="weight" type="number" step="0.001" min="0" value="${a && a.weight ? a.weight : ''}" placeholder="0,250" /></label>
        <label>Alto (cm) *<input name="height" type="number" step="0.1" min="0" value="${a && a.height ? a.height : ''}" /></label>
        <label>Ancho (cm) *<input name="width" type="number" step="0.1" min="0" value="${a && a.width ? a.width : ''}" /></label>
        <label>Profundidad / largo (cm) *<input name="depth" type="number" step="0.1" min="0" value="${a && a.depth ? a.depth : ''}" /></label>
      </div>
      <label class="check"><input type="checkbox" name="freeShipping" ${a && a.free_shipping ? 'checked' : ''} /> Envío gratis</label>

      <h3 style="margin-top:1rem">Publicación</h3>
      <label class="check"><input type="checkbox" name="publishOnline" ${!a || a.publish_online ? 'checked' : ''} /> Publicar en la tienda online (Tienda Nube)</label>
      <label class="check"><input type="checkbox" name="active" ${!a || a.active ? 'checked' : ''} /> Activo (se puede vender)</label>
      ${a && a.tn_product_id ? `<p class="muted">Publicado en Tienda Nube${a.tn_last_sync ? ` · última actualización ${fmtDateTime(a.tn_last_sync)}` : ''}</p>` : ''}
      ${a && a.tn_sync_error ? `<div class="alert danger">${esc(a.tn_sync_error)}</div>` : ''}
      <div class="alert danger hidden" id="form-error"></div>
      <div class="actions">
        ${a ? '<button type="button" class="danger" id="del">Eliminar</button><button type="button" class="secondary" id="sync">Publicar ahora</button>' : ''}
        <button type="button" class="secondary" data-close>Cancelar</button><button id="save">Guardar</button>
      </div>
    </form>`,
    { wide: true }
  );
  const f = $('#af', m);

  // --- Categorías ---
  const fillSubs = (selected = '') => {
    const cat = tree.find((c) => String(c.id) === String(f.category.value));
    const subs = cat ? cat.children : [];
    f.subcategory.innerHTML = `<option value="">${subs.length ? 'Sin subcategoría' : '—'}</option>` + subs.map((s) => `<option value="${s.id}" ${String(selected) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    f.subcategory.disabled = !cat;
    $('#add-sub', m).disabled = !cat;
  };
  f.category.onchange = () => fillSubs();
  fillSubs(sub);
  const quickCategory = async (parentId) => {
    const name = prompt(parentId ? 'Nombre de la nueva subcategoría' : 'Nombre de la nueva categoría');
    if (!name) return;
    const c = await act(() => adminApi('/api/admin/categories', { method: 'POST', body: { name, parentId } }), 'Categoría creada');
    if (!c) return;
    if (parentId) {
      tree.find((x) => x.id === parentId).children.push({ ...c, children: [] });
      fillSubs(c.id);
    } else {
      tree.push({ ...c, children: [] });
      f.category.insertAdjacentHTML('beforeend', `<option value="${c.id}">${esc(c.name)}</option>`);
      f.category.value = c.id;
      fillSubs();
    }
  };
  $('#add-cat', m).onclick = () => quickCategory(null);
  $('#add-sub', m).onclick = () => f.category.value && quickCategory(Number(f.category.value));

  // --- Fotos ---
  const renderPhotos = () => {
    $('#photos', m).innerHTML =
      st.images
        .map(
          (img, i) => `<div class="photo"><img src="${esc(img.src)}" alt="Foto ${i + 1}" />
          ${i === 0 ? '<span class="badge ok main">Principal</span>' : ''}
          <div class="photo-actions">
            ${i > 0 ? `<button type="button" class="secondary small" data-left="${i}" title="Mover a la izquierda">◀</button>` : ''}
            ${i < st.images.length - 1 ? `<button type="button" class="secondary small" data-right="${i}" title="Mover a la derecha">▶</button>` : ''}
            <button type="button" class="danger small" data-rm="${i}" title="Quitar">✕</button>
          </div></div>`
        )
        .join('') +
      (st.images.length < MAX_PHOTOS ? `<button type="button" class="photo add" id="add-photo"><span>+</span>Agregar foto</button>` : '');
    const move = (i, d) => {
      const [x] = st.images.splice(i, 1);
      st.images.splice(i + d, 0, x);
      renderPhotos();
    };
    $$('[data-left]', m).forEach((b) => (b.onclick = () => move(Number(b.dataset.left), -1)));
    $$('[data-right]', m).forEach((b) => (b.onclick = () => move(Number(b.dataset.right), 1)));
    $$('[data-rm]', m).forEach((b) => (b.onclick = () => (st.images.splice(Number(b.dataset.rm), 1), renderPhotos())));
    if ($('#add-photo', m)) $('#add-photo', m).onclick = () => $('#photo-input', m).click();
  };
  $('#photo-input', m).onchange = async (e) => {
    const files = [...e.target.files].slice(0, MAX_PHOTOS - st.images.length);
    for (const file of files) {
      try {
        const data = await resizeImage(file);
        st.images.push({ data, src: data });
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    e.target.value = '';
    renderPhotos();
  };
  renderPhotos();

  // --- Variantes ---
  const readVariantInputs = () => {
    $$('[data-vf]', m).forEach((inp) => {
      const row = st.variants[Number(inp.dataset.row)];
      if (!row) return;
      if (inp.dataset.vf === 'value') row.values[Number(inp.dataset.k)] = inp.value;
      else row[inp.dataset.vf] = inp.value;
    });
    $$('[data-attr]', m).forEach((inp) => (st.attributes[Number(inp.dataset.attr)] = inp.value));
  };
  // Muestra el margen del artículo simple mientras se cargan precio y costo.
  function updateMarginHint() {
    const hint = $('.margin-hint', m);
    if (!hint) return;
    const val = (k) => Number(($(`[data-vf="${k}"][data-row="0"]`, m) || {}).value) || 0;
    const price = val('promo_price') && val('promo_price') < val('price') ? val('promo_price') : val('price');
    const cost = val('cost');
    hint.textContent = price && cost ? `Ganancia por unidad: ${fmtMoney(price - cost)} (${Math.round(((price - cost) / price) * 100)}%)` : '';
  }
  m.addEventListener('input', (e) => e.target.matches('[data-vf]') && updateMarginHint());
  const renderVariants = () => {
    const box = $('#variants-box', m);
    if (!st.hasVariants) {
      const v = st.variants[0] || { values: [], sku: '', price: '', promo_price: '', stock: 0 };
      st.variants = [v];
      box.innerHTML = `<div class="grid cols-4">
        <label>Precio *<input type="number" min="0" step="0.01" data-vf="price" data-row="0" value="${esc(v.price)}" /></label>
        <label>Precio promocional<input type="number" min="0" step="0.01" data-vf="promo_price" data-row="0" value="${esc(v.promo_price)}" placeholder="opcional" /></label>
        <label>Costo<input type="number" min="0" step="0.01" data-vf="cost" data-row="0" value="${esc(v.cost)}" placeholder="lo que te cuesta" /></label>
        <label>Stock<input type="number" min="0" step="1" data-vf="stock" data-row="0" value="${esc(v.stock)}" /></label>
      </div>
      <div class="grid cols-4"><label>SKU / código<input data-vf="sku" data-row="0" value="${esc(v.sku)}" placeholder="opcional" /></label>
        <div class="muted margin-hint" style="align-self:center"></div></div>`;
      updateMarginHint();
      return;
    }
    const attrs = st.attributes;
    box.innerHTML = `
      <div class="card" style="background:var(--bg)">
        <p class="muted" style="margin-top:0">1. Escribí los tipos de variante y sus opciones separadas por coma, y tocá <b>Armar variantes</b>.</p>
        ${attrs
          .map(
            (name, k) => `<div class="grid cols-2" style="align-items:end">
              <label>Tipo de variante ${k + 1}<input data-attr="${k}" value="${esc(name)}" placeholder="${['Tamaño', 'Color', 'Aroma'][k] || ''}" /></label>
              <div class="row"><label class="grow">Opciones<input data-opts="${k}" placeholder="${['100ml, 250ml, 500ml', 'Rojo, Azul', 'Coco, Vainilla'][k] || ''}" /></label>
                ${attrs.length > 1 ? `<button type="button" class="danger small" data-rm-attr="${k}" style="margin-bottom:0.8em">✕</button>` : ''}</div>
            </div>`
          )
          .join('')}
        <div class="row">
          ${attrs.length < 3 ? '<button type="button" class="secondary small" id="add-attr">+ Otro tipo de variante</button>' : ''}
          <button type="button" class="small" id="gen">Armar variantes</button>
        </div>
      </div>
      <p class="muted">2. Completá precio y stock de cada variante.</p>
      <div class="table-wrap"><table class="variants">
        <tr>${attrs.map((x) => `<th>${esc(x || 'Variante')}</th>`).join('')}<th>Precio *</th><th>Promocional</th><th>Costo</th><th>Stock</th><th>SKU</th><th>Peso (kg)</th><th></th></tr>
        ${st.variants
          .map(
            (v, i) => `<tr>
            ${attrs.map((_, k) => `<td><input data-vf="value" data-k="${k}" data-row="${i}" value="${esc(v.values[k] || '')}" /></td>`).join('')}
            <td><input type="number" min="0" step="0.01" data-vf="price" data-row="${i}" value="${esc(v.price)}" /></td>
            <td><input type="number" min="0" step="0.01" data-vf="promo_price" data-row="${i}" value="${esc(v.promo_price)}" /></td>
            <td><input type="number" min="0" step="0.01" data-vf="cost" data-row="${i}" value="${esc(v.cost)}" /></td>
            <td><input type="number" min="0" step="1" data-vf="stock" data-row="${i}" value="${esc(v.stock)}" style="width:70px" /></td>
            <td><input data-vf="sku" data-row="${i}" value="${esc(v.sku)}" /></td>
            <td><input type="number" min="0" step="0.001" data-vf="weight" data-row="${i}" value="${esc(v.weight)}" placeholder="igual" style="width:80px" /></td>
            <td><button type="button" class="danger small" data-rm-row="${i}">✕</button></td></tr>`
          )
          .join('')}
      </table></div>
      <div class="row" style="margin-top:0.5rem">
        <button type="button" class="secondary small" id="add-row">+ Agregar variante</button>
        ${st.variants.length > 1 ? '<button type="button" class="secondary small" id="copy-price">Copiar precio y costo de la primera a todas</button>' : ''}
      </div>`;
    const on = (sel, fn) => $(sel, m) && ($(sel, m).onclick = fn);
    on('#add-attr', () => (readVariantInputs(), st.attributes.push(''), renderVariants()));
    $$('[data-rm-attr]', m).forEach(
      (b) =>
        (b.onclick = () => {
          readVariantInputs();
          const k = Number(b.dataset.rmAttr);
          st.attributes.splice(k, 1);
          st.variants.forEach((v) => v.values.splice(k, 1));
          renderVariants();
        })
    );
    on('#gen', () => {
      readVariantInputs();
      const lists = st.attributes.map((_, k) =>
        ($(`[data-opts="${k}"]`, m).value || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      );
      if (lists.some((l) => !l.length) || st.attributes.some((x) => !x.trim())) return toast('Completá cada tipo de variante con sus opciones', 'error');
      const key = (vals) => vals.map((x) => String(x).toLowerCase()).join('|');
      const existing = new Map(st.variants.filter((v) => v.values.length).map((v) => [key(v.values), v]));
      const first = st.variants[0] || st.seed || {};
      st.variants = combinations(lists).map(
        (vals) => existing.get(key(vals)) || { values: vals, sku: '', price: first.price || '', promo_price: '', cost: first.cost ?? '', stock: 0, weight: '' }
      );
      renderVariants();
    });
    on('#add-row', () => (readVariantInputs(), st.variants.push({ values: [], sku: '', price: '', promo_price: '', stock: 0, weight: '' }), renderVariants()));
    on('#copy-price', () => {
      readVariantInputs();
      st.variants.forEach((v) => {
        v.price = st.variants[0].price;
        v.promo_price = st.variants[0].promo_price;
        v.cost = st.variants[0].cost;
      });
      renderVariants();
    });
    $$('[data-rm-row]', m).forEach((b) => (b.onclick = () => (readVariantInputs(), st.variants.splice(Number(b.dataset.rmRow), 1), renderVariants())));
  };
  $('#has-variants', m).onchange = (e) => {
    readVariantInputs();
    st.hasVariants = e.target.checked;
    if (st.hasVariants) {
      if (!st.attributes.length) st.attributes = [''];
      // El precio cargado se usa como precio inicial de las variantes que se armen.
      st.seed = st.variants[0];
      if (!st.variants.some((v) => v.values.length)) st.variants = [];
    } else {
      const first = st.variants[0];
      st.variants = [first ? { ...first, values: [] } : { values: [], sku: '', price: '', promo_price: '', stock: 0, weight: '' }];
    }
    renderVariants();
  };
  renderVariants();

  // --- Guardar ---
  const showError = (msg) => {
    const el = $('#form-error', m);
    el.textContent = msg;
    el.classList.remove('hidden');
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    readVariantInputs();
    $('#form-error', m).classList.add('hidden');
    if (!st.images.length) return showError('Agregá al menos una foto del artículo.');
    if (st.hasVariants && !st.variants.length) return showError('Armá las variantes y completá su precio.');
    const body = {
      name: f.name.value,
      brand: f.brand.value,
      categoryId: f.subcategory.value || f.category.value,
      description: f.description.value,
      minStock: f.minStock.value,
      weight: f.weight.value,
      height: f.height.value,
      width: f.width.value,
      depth: f.depth.value,
      freeShipping: f.freeShipping.checked,
      publishOnline: f.publishOnline.checked,
      active: f.active.checked,
      attributes: st.hasVariants ? st.attributes.map((x) => x.trim()) : [],
      images: st.images.map((img) => (img.id ? { id: img.id } : { data: img.data })),
      variants: st.variants.map((v) => ({
        id: v.id,
        values: st.hasVariants ? v.values : [],
        sku: v.sku,
        price: v.price,
        promo_price: v.promo_price,
        cost: v.cost,
        stock: v.stock,
        weight: v.weight,
      })),
    };
    $('#save', m).disabled = true;
    $('#save', m).textContent = 'Guardando…';
    try {
      await adminApi(a ? `/api/admin/articles/${a.id}` : '/api/admin/articles', { method: a ? 'PUT' : 'POST', body });
      toast(f.publishOnline.checked && app.tnConnected ? 'Artículo guardado. Se está publicando en la tienda.' : 'Artículo guardado');
      m.remove();
      if (app.view === 'inventario') renderArticles();
    } catch (err) {
      showError(err.message);
      $('#save', m).disabled = false;
      $('#save', m).textContent = 'Guardar';
    }
  };
  if (a) {
    $('#del', m).onclick = async () => {
      if (!confirm('¿Eliminar el artículo? Si tiene ventas o está publicado, se desactiva y se despublica de la tienda.')) return;
      const r = await act(() => adminApi(`/api/admin/articles/${a.id}`, { method: 'DELETE' }));
      if (r) {
        toast(r.deactivated ? 'Artículo desactivado' : 'Artículo eliminado');
        m.remove();
        renderArticles();
      }
    };
    $('#sync', m).onclick = async () => {
      $('#sync', m).disabled = true;
      if (await act(() => adminApi(`/api/admin/articles/${a.id}/sync`, { method: 'POST' }), 'Publicado en Tienda Nube')) {
        m.remove();
        renderArticles();
      } else $('#sync', m).disabled = false;
    };
  }
}

async function renderCategories() {
  const tree = await adminApi('/api/admin/categories');
  app.categories = tree;
  $('#tab').innerHTML = `<div class="card">
    <div class="row between"><h2 style="margin:0">Categorías</h2><button class="small" id="new-cat">+ Nueva categoría</button></div>
    <p class="muted">Se crean igual en tu Tienda Nube cuando publicás un artículo de esa categoría.</p>
    ${
      tree.length
        ? tree
            .map(
              (c) => `<div class="cat-row"><div class="row between">
                <div><b>${esc(c.name)}</b> <small class="muted">${c.articles} artículo(s)</small> ${c.tn_category_id ? '<span class="badge ok">En la tienda</span>' : ''}</div>
                <div class="row"><button class="secondary small" data-sub="${c.id}">+ Subcategoría</button><button class="secondary small" data-ren="${c.id}">Renombrar</button><button class="danger small" data-del="${c.id}">Eliminar</button></div></div>
                ${c.children
                  .map(
                    (s) => `<div class="row between cat-sub"><div>› ${esc(s.name)} <small class="muted">${s.articles} artículo(s)</small> ${s.tn_category_id ? '<span class="badge ok">En la tienda</span>' : ''}</div>
                    <div class="row"><button class="secondary small" data-ren="${s.id}">Renombrar</button><button class="danger small" data-del="${s.id}">Eliminar</button></div></div>`
                  )
                  .join('')}</div>`
            )
            .join('')
        : '<p class="muted">Todavía no hay categorías. Ej: "Cuidado corporal" con subcategorías "Post solar" y "Exfoliantes".</p>'
    }</div>`;
  const all = tree.flatMap((c) => [c, ...c.children]);
  const save = async (body, id) => {
    if (await act(() => adminApi(id ? `/api/admin/categories/${id}` : '/api/admin/categories', { method: id ? 'PUT' : 'POST', body }), 'Guardado')) renderCategories();
  };
  $('#new-cat').onclick = () => {
    const name = prompt('Nombre de la categoría');
    if (name) save({ name });
  };
  $$('[data-sub]').forEach(
    (b) =>
      (b.onclick = () => {
        const name = prompt('Nombre de la subcategoría');
        if (name) save({ name, parentId: Number(b.dataset.sub) });
      })
  );
  $$('[data-ren]').forEach(
    (b) =>
      (b.onclick = () => {
        const c = all.find((x) => x.id === Number(b.dataset.ren));
        const name = prompt('Nuevo nombre', c.name);
        if (name && name !== c.name) save({ name, parentId: c.parent_id }, c.id);
      })
  );
  $$('[data-del]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm('¿Eliminar la categoría?')) return;
        if (await act(() => adminApi(`/api/admin/categories/${b.dataset.del}`, { method: 'DELETE' }), 'Categoría eliminada')) renderCategories();
      })
  );
}

async function discountModal() {
  const tree = await adminApi('/api/admin/categories');
  const m = modal(`<h2>Descuentos</h2>
    <p class="muted">Se aplica como <b>precio promocional</b>: en la tienda online se muestra el precio anterior tachado, y la caja cobra el precio con descuento.</p>
    <form id="df">
      <label>¿A qué artículos?<select name="categoryId"><option value="">Todo el inventario</option>${categoryOptions(tree)}</select></label>
      <label>Descuento (%)<input name="percent" type="number" min="1" max="99" step="1" placeholder="Ej: 15" /></label>
      <div class="actions">
        <button type="button" class="danger" id="clear">Quitar descuentos</button>
        <button type="button" class="secondary" data-close>Cancelar</button><button>Aplicar descuento</button>
      </div>
    </form>`);
  const f = $('#df', m);
  const apply = async (percent) => {
    const scope = f.categoryId.value ? `la categoría "${f.categoryId.selectedOptions[0].textContent.replace('›', '').trim()}"` : 'todo el inventario';
    if (!confirm(percent ? `¿Aplicar ${percent}% de descuento a ${scope}?` : `¿Quitar los precios promocionales de ${scope}?`)) return;
    const r = await act(() => adminApi('/api/admin/articles/discount', { method: 'POST', body: { percent, categoryId: f.categoryId.value || null } }));
    if (!r) return;
    toast(`${percent ? 'Descuento aplicado' : 'Descuentos quitados'}: ${r.articles} artículo(s), ${r.variants} variante(s)`);
    m.remove();
    if (app.view === 'inventario') renderArticles();
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    const p = Number(f.percent.value);
    if (!p || p < 1 || p > 99) return toast('Ingresá un porcentaje entre 1 y 99', 'error');
    apply(p);
  };
  $('#clear', m).onclick = () => apply(0);
}

// ---------- Clientas ----------

// Link de WhatsApp para un celular argentino (agrega 549 si falta).
function waLink(phone) {
  let d = String(phone || '').replace(/\D/g, '').replace(/^00/, '');
  if (!d) return null;
  if (d.startsWith('54')) d = d.slice(2);
  d = d.replace(/^0/, '');
  return `https://wa.me/54${d.startsWith('9') ? d : `9${d}`}`;
}

function clientModal(c = null, onSaved = () => {}) {
  const m = modal(`<h2>${c ? 'Editar clienta' : 'Nueva clienta'}</h2><form id="f">
    <label>Nombre y apellido *<input name="name" required value="${esc(c ? c.name : '')}" /></label>
    <div class="grid cols-2"><label>Teléfono (WhatsApp)<input name="phone" type="tel" value="${esc(c && c.phone ? c.phone : '')}" placeholder="11 2345 6789" /></label>
    <label>Email<input name="email" type="email" value="${esc(c && c.email ? c.email : '')}" /></label></div>
    <label>Notas (tipo de piel, preferencias, alergias…)<textarea name="notes" rows="3">${esc(c && c.notes ? c.notes : '')}</textarea></label>
    <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button>${c ? 'Guardar' : 'Crear clienta'}</button></div></form>`);
  $('#f', m).onsubmit = async (e) => {
    e.preventDefault();
    const saved = await act(() => adminApi(c ? `/api/admin/clients/${c.id}` : '/api/admin/clients', { method: c ? 'PUT' : 'POST', body: formData(e.target) }), c ? 'Guardado' : 'Clienta creada');
    if (saved) {
      m.remove();
      onSaved(saved);
    }
  };
}

VIEWS.clientes = async () => {
  $('#main').innerHTML = `<div class="page-head"><h1>Clientas</h1><button id="new-client">+ Nueva clienta</button></div>
    <div class="card"><input id="q" placeholder="Buscar por nombre, teléfono o email" style="margin-bottom:0.8rem" /><div id="list"></div></div>`;
  const load = async (q = '') => {
    const list = await adminApi(`/api/admin/clients?q=${encodeURIComponent(q)}`);
    $('#list').innerHTML = list.length
      ? `<div class="table-wrap"><table><tr><th>Nombre</th><th>Teléfono</th><th>Email</th><th class="num">Visitas</th><th>Última</th><th></th></tr>
        ${list
          .map(
            (c) => `<tr><td>${esc(c.name)}${c.notes ? `<br><small class="muted">${esc(c.notes.slice(0, 60))}${c.notes.length > 60 ? '…' : ''}</small>` : ''}</td>
            <td>${c.phone ? `<a target="_blank" href="${esc(waLink(c.phone))}">${esc(c.phone)}</a>` : ''}</td>
            <td>${esc(c.email || '')}</td><td class="num">${c.visits}</td><td>${c.last_visit ? fmtDate(c.last_visit, { day: '2-digit', month: '2-digit', year: '2-digit' }) : ''}</td>
            <td style="white-space:nowrap"><button class="small" data-appt-new="${c.id}">Dar turno</button>
              <button class="secondary small" data-edit="${c.id}">Editar</button>
              <button class="secondary small" data-turnos="${esc(c.phone || c.name)}">Turnos</button></td></tr>`
          )
          .join('')}</table></div>`
      : `<p class="muted">${q ? 'Sin resultados.' : 'Todavía no hay clientas. Se agregan solas al reservar o comprar online, o cargalas con "+ Nueva clienta".'}</p>`;
    $$('[data-turnos]').forEach(
      (b) =>
        (b.onclick = () => {
          Object.assign(app.agenda, { q: b.dataset.turnos, from: addDays(today(), -180), days: 30, status: '' });
          location.hash = 'agenda';
        })
    );
    $$('[data-edit]').forEach((b) => (b.onclick = () => clientModal(list.find((x) => x.id === Number(b.dataset.edit)), () => load($('#q').value))));
    $$('[data-appt-new]').forEach(
      (b) =>
        (b.onclick = async () => {
          await loadServices();
          newAppointmentModal({ client: list.find((x) => x.id === Number(b.dataset.apptNew)) });
        })
    );
  };
  $('#new-client').onclick = () =>
    clientModal(null, (c) => {
      $('#q').value = c.name;
      load(c.name);
    });
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
  app.ticketCfg = null; // el ticket vuelve a leer los datos del negocio
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
      <h2 style="margin-top:1rem">Ticket de venta</h2>
      <div class="grid cols-2">
        <label>Ancho del papel<select name="ticket_width"><option value="80" ${s.ticket_width !== '58' ? 'selected' : ''}>80 mm (térmica estándar / impresora común)</option><option value="58" ${s.ticket_width === '58' ? 'selected' : ''}>58 mm (térmica chica)</option></select></label>
        <label>Mensaje al pie del ticket<input name="ticket_footer" value="${esc(s.ticket_footer)}" /></label>
      </div>
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
      <div class="table-wrap"><table><tr><th>Servicio</th><th class="num">Duración</th><th class="num">Precio</th><th class="num">Seña</th><th class="num">Costo</th><th class="num">Margen</th><th>Estado</th><th></th></tr>
      ${list
        .map(
          (s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.duration_min} min</td><td class="num">${fmtMoney(s.price)}</td><td class="num">${fmtMoney(s.deposit_amount)}</td>
          <td class="num">${s.cost === null || s.cost === undefined ? '<span class="badge warn">sin costo</span>' : fmtMoney(s.cost)}</td>
          <td class="num">${s.cost === null || s.cost === undefined || !s.price ? '-' : `${Math.round(((s.price - s.cost) / s.price) * 100)}%`}</td>
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
        <label>Costo por sesión (insumos: solución, descartables…)<input name="cost" type="number" step="0.01" min="0" value="${s?.cost ?? ''}" placeholder="Para calcular la ganancia en Resultados" /></label>
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
