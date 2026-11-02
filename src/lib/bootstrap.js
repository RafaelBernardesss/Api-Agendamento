const prisma = require('../db');
const { normalizePhone } = require('./schedule');

const DEFAULT_SERVICES = [
  { name: 'Design de Sobrancelhas', durationMinutes: 30 },
  { name: 'Design de Sobrancelhas com Henna', durationMinutes: 60 },
  { name: 'Limpeza de Pele', durationMinutes: 90 },
  { name: 'Massagem', durationMinutes: 60 },
  { name: 'Peeling Facial', durationMinutes: 60 },
  { name: 'Hidratação Facial', durationMinutes: 60 },
  { name: 'Depilação de Buço', durationMinutes: 5 },
  { name: 'Axila', durationMinutes: 15 },
  { name: 'Virilha', durationMinutes: 30 },
  { name: 'Meia Perna', durationMinutes: 30 },
  { name: 'Perna Inteira', durationMinutes: 60 },
];

async function ensureBaseData({ forceServices = false } = {}) {

  if (forceServices || (await prisma.service.count()) === 0) {
    for (const [i, s] of DEFAULT_SERVICES.entries()) {
      await prisma.service.upsert({ where: { name: s.name }, update: {}, create: { name: s.name, sortOrder: i, durationMinutes: s.durationMinutes } });
    }
  }

  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const phone = normalizePhone(process.env.ADMIN_PHONE || '');
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  if (!(process.env.ADMIN_NAME || '').trim()) {
    console.warn('AVISO: ADMIN_NAME ausente no .env. Sem o nome do admin, ninguém consegue entrar na Área Administrativa.');
  }

  if (!phone || !emailOk) {
    console.warn('AVISO: ADMIN_PHONE / ADMIN_EMAIL ausentes ou inválidos no .env. A Área Administrativa ficará inacessível.');
    return { admin: false };
  }
  await prisma.admin.upsert({
    where: { username },
    update: { phone, email },
    create: { username, phone, email },
  });
  return { admin: true, username, email };
}

module.exports = { ensureBaseData, DEFAULT_SERVICES };
