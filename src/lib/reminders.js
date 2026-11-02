const S = require('./schedule');
const { ADMIN_INBOX } = require('./status');
const { WITH_SERVICES, serviceNames } = require('./appointmentServices');

const CHECK_EVERY_MS = 10 * 60 * 1000;
const MAX_LINES = 15;

function addDaysStr(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

const br = (dateStr) => dateStr.split('-').reverse().join('/');

function reminderHour() {
  const n = Number(process.env.REMINDER_HOUR);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 9;
}

function createReminderJob({ prisma, sendPush, nowFn = () => new Date(), hourFn = reminderHour }) {
  let running = false;

  async function runOnce() {
    if (running) return { sent: 0, skipped: 'busy' };
    running = true;
    try {
      const now = S.nowInSaoPaulo(nowFn());
      if (now.minutes < hourFn() * 60) return { sent: 0, skipped: 'early' };

      const target = addDaysStr(now.date, 1);
      const candidates = await prisma.appointment.findMany({
        where: { date: target, status: 'CONFIRMED', reminderSentAt: null },
        include: WITH_SERVICES,
        orderBy: [{ time: 'asc' }],
      });
      const due = candidates.filter((a) => S.needsSecondConfirmation(a.createdAt, a.date));

      const sent = [];
      for (const a of due) {
        const ok = await prisma.$transaction(async (tx) => {
          const claimed = await tx.appointment.updateMany({
            where: { id: a.id, status: 'CONFIRMED', reminderSentAt: null },
            data: { reminderSentAt: new Date() },
          });
          if (claimed.count !== 1) return false;
          await tx.notification.create({
            data: {
              phone: a.phone,
              kind: 'REMINDER',
              title: 'Confirme sua presença',
              message: `Seu agendamento de ${serviceNames(a)} é amanhã, ${br(a.date)} às ${a.time}. Você vai comparecer? Toque aqui para responder.`,
            },
          });
          return true;
        });
        if (ok) sent.push(a);
      }

      if (sent.length) await notifyAdmin(sent, target);
      for (const a of sent) {
        await sendPush([a.phone], {
          title: 'Confirme sua presença',
          body: `Seu agendamento de ${serviceNames(a)} é amanhã às ${a.time}. Toque para responder.`,
          data: { screen: '/agendamentos' },
        });
      }
      return { sent: sent.length };
    } finally {
      running = false;
    }
  }

  async function notifyAdmin(sent, target) {
    const lines = sent.slice(0, MAX_LINES).map((a) => `${a.time} · ${a.clientName} · ${serviceNames(a)}`);
    if (sent.length > MAX_LINES) lines.push(`e mais ${sent.length - MAX_LINES}…`);
    const title =
      sent.length === 1
        ? 'Lembrete enviado para 1 agendamento de amanhã'
        : `Lembretes enviados para ${sent.length} agendamentos de amanhã`;
    await prisma.notification.create({
      data: {
        phone: ADMIN_INBOX,
        title,
        message: `Pedimos a confirmação de presença (${br(target)}):\n${lines.join('\n')}`,
      },
    });
    const preview = sent.slice(0, 3).map((a) => `${a.time} ${a.clientName}`).join(', ');
    await sendPush([ADMIN_INBOX], {
      title,
      body: sent.length > 3 ? `${preview} e mais ${sent.length - 3}` : preview,
      data: { screen: '/admin' },
    });
  }

  return { runOnce };
}

function start() {
  const prisma = require('../db');
  const { sendPush } = require('./push');
  const job = createReminderJob({ prisma, sendPush });
  const tick = () => job.runOnce().catch((err) => console.error('Erro no lembrete automático:', err));
  setTimeout(tick, 10 * 1000);
  return setInterval(tick, CHECK_EVERY_MS);
}

module.exports = { createReminderJob, addDaysStr, reminderHour, start };
