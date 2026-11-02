const prisma = require('../db');
const S = require('./schedule');

async function finishPastAppointments() {
  const now = S.nowInSaoPaulo();
  const candidates = await prisma.appointment.findMany({
    where: { status: 'CONFIRMED', date: { lte: now.date } },
    select: { id: true, date: true, time: true, durationMinutes: true },
  });
  const ids = candidates
    .filter((a) => a.date < now.date || S.toMinutes(a.time) + (a.durationMinutes || S.SLOT_MINUTES) <= now.minutes)
    .map((a) => a.id);
  if (ids.length) {
    await prisma.appointment.updateMany({ where: { id: { in: ids }, status: 'CONFIRMED' }, data: { status: 'DONE' } });
  }
}

module.exports = { finishPastAppointments };
