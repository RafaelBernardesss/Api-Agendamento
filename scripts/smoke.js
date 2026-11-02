require('dotenv').config();

const BASE = process.env.SMOKE_URL || `http://localhost:${process.env.PORT || 3000}/api`;
const PHONE = '(17) 90000-0001';
let failed = 0;

function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FALHOU'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failed++;
}

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

function nextOpenWeekday() {
  const d = new Date(Date.now() + 2 * 86400000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

(async () => {
  const health = await call('/health');
  check('health', health.status === 200);

  const services = await call('/services');
  check('lista serviços', services.status === 200 && services.json.length >= 1, JSON.stringify(services.json));
  const serviceId = services.json[0].id;

  const date = nextOpenWeekday();
  const month = date.slice(0, 7);
  const av = await call(`/availability?month=${month}`);
  const day = av.json && av.json.days.find((x) => x.date === date);
  check('calendário mostra o dia aberto', av.status === 200 && day && day.open, JSON.stringify(day));

  const slots = await call(`/slots?date=${date}`);
  check('horários do dia', slots.status === 200 && slots.json.slots.length > 0);
  const time = slots.json.slots[0];

  const sunday = new Date(date + 'T00:00:00Z'); while (sunday.getUTCDay() !== 0) sunday.setUTCDate(sunday.getUTCDate() + 1);
  const sun = await call(`/slots?date=${sunday.toISOString().slice(0, 10)}`);
  check('domingo sem horários', sun.status === 200 && sun.json.slots.length === 0);

  const bad = await call('/appointments', { method: 'POST', body: { clientName: 'X', phone: '123', serviceId, date, time } });
  check('rejeita dados inválidos (400)', bad.status === 400, JSON.stringify(bad));

  const body = { clientName: 'Cliente Teste', phone: PHONE, serviceId, date, time };
  const a = await call('/appointments', { method: 'POST', body });
  check('cria agendamento já confirmado (201)', a.status === 201 && a.json.time === time && a.json.status === 'CONFIRMED', JSON.stringify(a));

  const dup = await call('/appointments', { method: 'POST', body: { ...body, clientName: 'Outra Pessoa', phone: '(17) 90000-0002' } });
  check('mesmo horário é recusado (409)', dup.status === 409, JSON.stringify(dup));

  const mine = await call(`/appointments?phone=${encodeURIComponent(PHONE)}`);
  check('consulta por telefone', mine.status === 200 && mine.json.some((x) => x.id === a.json.id));

  const notes = await call(`/notifications?phone=${encodeURIComponent(PHONE)}`);
  check('gerou notificação', notes.status === 200 && notes.json.length >= 1);

  const stranger = await call(`/appointments/${a.json.id}/cancel`, { method: 'POST', body: { phone: '(17) 90000-0002' } });
  check('outro telefone não cancela (404)', stranger.status === 404);

  const unauth = await call('/admin/appointments');
  check('admin sem login (401)', unauth.status === 401);

  const reg = await call('/auth/login', { method: 'POST', body: { name: 'Cliente Teste', phone: PHONE } });
  check('cadastro do cliente (nome + telefone)', reg.status === 200 && reg.json.admin === false && reg.json.user.phone === '17900000001', JSON.stringify(reg));

  if (process.env.ADMIN_PHONE && process.env.ADMIN_EMAIL && process.env.ADMIN_NAME) {
    const adm = await call('/auth/login', { method: 'POST', body: { name: process.env.ADMIN_NAME, phone: process.env.ADMIN_PHONE } });
    check('telefone do admin pede verificação por e-mail', adm.status === 200 && adm.json.admin === true, JSON.stringify(adm));

    const wrongMail = await call('/admin/request-code', { method: 'POST', body: { phone: process.env.ADMIN_PHONE, name: process.env.ADMIN_NAME, email: 'nao-e-o-admin@exemplo.com' } });
    check('pedido de código com e-mail errado não revela nada (200 neutro)', wrongMail.status === 200, JSON.stringify(wrongMail));

    const bogus = await call('/admin/verify-code', { method: 'POST', body: { phone: process.env.ADMIN_PHONE, name: process.env.ADMIN_NAME, email: process.env.ADMIN_EMAIL, code: '000000' } });
    check('código inventado é recusado (401)', bogus.status === 401, JSON.stringify(bogus));

    const token = require('jsonwebtoken').sign({ role: 'admin', sub: 0, username: 'smoke' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const list = await call(`/admin/appointments?date=${date}`, { token });
    check('admin (com token) vê a agenda do dia', list.status === 200 && list.json.some((x) => x.id === a.json.id), JSON.stringify(list.json));
  } else {
    console.log('PULOU  verificações do admin (defina ADMIN_PHONE, ADMIN_NAME e ADMIN_EMAIL no .env)');
  }

  const cancel = await call(`/appointments/${a.json.id}/cancel`, { method: 'POST', body: { phone: PHONE } });
  check('cliente cancela o próprio (200)', cancel.status === 200 && cancel.json.status === 'CANCELED');

  const again = await call('/appointments', { method: 'POST', body });
  check('horário liberado após cancelar (201)', again.status === 201, JSON.stringify(again));
  if (again.status === 201) await call(`/appointments/${again.json.id}/cancel`, { method: 'POST', body: { phone: PHONE } });

  console.log(failed ? `\n${failed} verificação(ões) falharam.` : '\nTudo certo.');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Não consegui falar com a API. O servidor está ligado?', e.message);
  process.exit(1);
});
