const state = { info: null, service: null, date: null, time: null, data: null };

function goStep(n) {
  for (let i = 1; i <= 4; i++) $(`#step-${i}`).classList.toggle('hidden', i !== n);
  $$('#steps span').forEach((s, i) => s.classList.toggle('on', i < n));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('[data-back]').forEach((b) => b.addEventListener('click', () => goStep(Number(b.dataset.back))));

async function init() {
  try {
    state.info = await api('/api/public/info');
  } catch (err) {
    $('#services').innerHTML = `<div class="alert danger">${esc(err.message)}</div>`;
    return;
  }
  const info = state.info;
  document.title = `Reservá tu turno - ${info.business_name}`;
  $('#biz').textContent = info.business_name;
  $('#biz-info').textContent = [info.business_address, info.business_phone].filter(Boolean).join(' · ');
  $('#terms').textContent = info.terms || '';

  if (!info.services.length) {
    $('#services').innerHTML = '<p class="muted">No hay servicios disponibles para reservar online.</p>';
    return;
  }
  $('#services').innerHTML = info.services
    .map(
      (s) => `<button class="service-option" data-id="${s.id}">
        <div class="row between"><strong>${esc(s.name)}</strong><span>${fmtMoney(s.price)}</span></div>
        ${s.description ? `<div class="muted">${esc(s.description)}</div>` : ''}
        <small>${s.duration_min} min${s.deposit_amount > 0 ? ` · Seña ${fmtMoney(s.deposit_amount)}` : ''}</small>
      </button>`
    )
    .join('');
  $$('.service-option').forEach((b) =>
    b.addEventListener('click', () => {
      state.service = info.services.find((s) => s.id === Number(b.dataset.id));
      state.date = null;
      state.time = null;
      renderDays();
      goStep(2);
    })
  );
}

function renderDays() {
  const days = state.info.open_days;
  if (!days.length) {
    $('#days').innerHTML = '<p class="muted">No hay días disponibles por el momento.</p>';
    return;
  }
  $('#days').innerHTML = days
    .map((d) => {
      const dt = new Date(`${d}T12:00:00`);
      return `<button class="day" data-date="${d}">
        <small>${dt.toLocaleDateString('es-AR', { weekday: 'short' })}</small>
        <b>${dt.getDate()}</b>
        <small>${dt.toLocaleDateString('es-AR', { month: 'short' })}</small>
      </button>`;
    })
    .join('');
  $$('.day').forEach((b) => b.addEventListener('click', () => selectDay(b.dataset.date)));
  $('#slots').innerHTML = '';
  $('#slots-msg').textContent = 'Elegí un día para ver los horarios disponibles.';
  $('#slots-msg').classList.remove('hidden');
}

async function selectDay(date) {
  state.date = date;
  $$('.day').forEach((b) => b.classList.toggle('selected', b.dataset.date === date));
  $('#slots').innerHTML = '';
  $('#slots-msg').textContent = 'Buscando horarios…';
  $('#slots-msg').classList.remove('hidden');
  try {
    const { slots } = await api(`/api/public/slots?serviceId=${state.service.id}&date=${date}`);
    if (!slots.length) {
      $('#slots-msg').textContent = 'No quedan horarios libres ese día. Probá con otro.';
      return;
    }
    $('#slots-msg').classList.add('hidden');
    $('#slots').innerHTML = slots.map((t) => `<button class="slot" data-time="${t}">${t}</button>`).join('');
    $$('.slot').forEach((b) =>
      b.addEventListener('click', () => {
        state.time = b.dataset.time;
        goStep(3);
      })
    );
  } catch (err) {
    $('#slots-msg').textContent = err.message;
  }
}

$('#form-data').addEventListener('submit', (e) => {
  e.preventDefault();
  state.data = Object.fromEntries(new FormData(e.target));
  const s = state.service;
  const deposit = s.deposit_amount > 0;
  $('#summary').innerHTML = `
    <div class="summary-line"><span>Servicio</span><b>${esc(s.name)}</b></div>
    <div class="summary-line"><span>Día</span><b>${fmtDate(state.date)}</b></div>
    <div class="summary-line"><span>Horario</span><b>${state.time} hs</b></div>
    <div class="summary-line"><span>A nombre de</span><b>${esc(state.data.name)}</b></div>
    <div class="summary-line"><span>Precio del servicio</span><span>${fmtMoney(s.price)}</span></div>
    ${
      deposit
        ? `<div class="summary-line total"><span>Seña a pagar ahora</span><span>${fmtMoney(s.deposit_amount)}</span></div>
           <div class="summary-line"><span class="muted">Resto a abonar en el local</span><span class="muted">${fmtMoney(s.price - s.deposit_amount)}</span></div>
           <p class="muted">Tenés ${state.info.hold_minutes} minutos para completar el pago. Si no se acredita, el horario se libera.</p>`
        : ''
    }`;
  $('#confirm').textContent = deposit ? 'Pagar seña con Mercado Pago' : 'Confirmar turno';
  $('#err').classList.add('hidden');
  goStep(4);
});

$('#confirm').addEventListener('click', async () => {
  const btn = $('#confirm');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Procesando…';
  try {
    const res = await api('/api/public/bookings', {
      method: 'POST',
      body: { serviceId: state.service.id, date: state.date, time: state.time, ...state.data },
    });
    if (res.init_point) {
      location.href = res.init_point;
    } else {
      location.href = `/reserva.html?t=${res.booking.token}`;
    }
  } catch (err) {
    $('#err').textContent = err.message;
    $('#err').classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = label;
    if (err.status === 409) {
      setTimeout(() => {
        goStep(2);
        selectDay(state.date);
      }, 1800);
    }
  }
});

init();
