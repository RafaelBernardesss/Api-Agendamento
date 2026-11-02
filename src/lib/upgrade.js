async function upgradeAppointments(db = require('../db')) {
  const confirmed = await db.appointment.updateMany({ where: { status: 'PENDING' }, data: { status: 'CONFIRMED' } });

  const missing = await db.appointment.findMany({ where: { services: { none: {} } }, select: { id: true, serviceId: true } });
  if (missing.length > 0) {
    await db.appointmentService.createMany({ data: missing.map((a) => ({ appointmentId: a.id, serviceId: a.serviceId })) });
  }
  return { confirmed: confirmed.count, servicesFilled: missing.length };
}

module.exports = { upgradeAppointments };
