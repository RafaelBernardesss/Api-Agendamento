require('dotenv').config();

const { normalizePhone } = require('../src/lib/schedule');

const prisma = require('../src/db');

const SERVICES = [
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

const RENAMED = { 'Massagem Relaxante': 'Massagem', 'Depilação': 'Depilação de Buço' };

async function main() {
  for (const [oldName, newName] of Object.entries(RENAMED)) {
    const old = await prisma.service.findUnique({ where: { name: oldName } });
    const exists = await prisma.service.findUnique({ where: { name: newName } });
    if (old && !exists) await prisma.service.update({ where: { id: old.id }, data: { name: newName } });
  }
  for (const [i, s] of SERVICES.entries()) {
    await prisma.service.upsert({
      where: { name: s.name },
      update: { durationMinutes: s.durationMinutes, sortOrder: i, active: true },
      create: { name: s.name, sortOrder: i, durationMinutes: s.durationMinutes },
    });
  }
  await prisma.service.updateMany({ where: { name: { notIn: SERVICES.map((s) => s.name) } }, data: { active: false } });

  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const phone = normalizePhone(process.env.ADMIN_PHONE || '');
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!phone || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.warn('ADMIN_PHONE / ADMIN_EMAIL ausentes ou inválidos no .env: admin NÃO foi criado.');
  } else {
    await prisma.admin.upsert({
      where: { username },
      update: { phone, email },
      create: { username, phone, email },
    });
    console.log(`Admin "${username}" pronto (código de acesso será enviado para ${email}).`);
  }
  console.log(`${SERVICES.length} serviços garantidos.`);

  const up = await require('../src/lib/upgrade').upgradeAppointments(prisma);
  if (up.confirmed || up.servicesFilled) {
    console.log(`Agendamentos antigos ajustados: ${up.confirmed} confirmado(s) automaticamente, ${up.servicesFilled} com lista de serviços criada.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
