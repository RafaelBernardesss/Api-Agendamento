const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const prisma = require('../db');
const { HttpError, wrap } = require('../lib/http');
const S = require('../lib/schedule');
const { OPEN, INACTIVE, ADMIN_INBOX } = require('../lib/status');
const { adminNameMatches } = require('../lib/adminName');
const log = require('../lib/logger');
const { sendPush } = require('../lib/push');
const A = require('../lib/availability');
const { WITH_SERVICES, serviceList, serviceNames, resolveServices, totalDuration } = require('../lib/appointmentServices');

const router = express.Router();

const MAX_ACTIVE_PER_PHONE = 5;

function parseServiceIds(query) {
  const raw = query.serviceIds !== undefined && query.serviceIds !== '' ? query.serviceIds : query.serviceId;
  if (raw === undefined || raw === '') return [];
  const ids = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (ids.some((id) => !Number.isInteger(id))) throw new HttpError(400, 'Serviço inválido.');
  return ids;
}

async function durationFor(query) {
  const ids = parseServiceIds(query);
  if (ids.length > 0) return totalDuration(await resolveServices(prisma, ids, HttpError));
  const agg = await prisma.service.aggregate({ where: { active: true }, _min: { durationMinutes: true } });
  return agg._min.durationMinutes || undefined;
}

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
});

const phoneSchema = z
  .string({ required_error: 'Informe o telefone.' })
  .transform((v) => S.normalizePhone(v))
  .refine((v) => v !== null, { message: 'Telefone inválido. Use DDD + número, ex.: (17) 99999-9999.' });

function publicAppointment(a) {
  return {
    id: a.id,
    clientName: a.clientName,
    date: a.date,
    time: a.time,
    status: a.status,
    rejectReason: a.rejectReason || undefined,
    reminderSent: !!a.reminderSentAt,
    presence: a.presence || undefined,
    presenceReason: a.presenceReason || undefined,
    service: serviceNames(a) || undefined,
    services: serviceList(a),
    durationMinutes: a.durationMinutes,
  };
}

const loginSchema = z.object({
  name: z
    .string({ required_error: 'Informe seu nome.' })
    .trim()
    .min(2, 'Informe seu nome.')
    .max(80, 'Nome muito longo.'),
  phone: phoneSchema,
});

router.post(
  '/auth/login',
  writeLimiter,
  wrap(async (req, res) => {
    const { name, phone } = loginSchema.parse(req.body);

    const admin = await prisma.admin.findFirst({ where: { phone } });
    if (admin && admin.email && adminNameMatches(name)) return res.json({ admin: true });

    const user = await prisma.user.upsert({
      where: { phone },
      update: { name },
      create: { name, phone },
    });
    res.json({ admin: false, user: { id: user.id, name: user.name, phone: user.phone } });
  })
);

router.get('/health', (_req, res) => res.json({ ok: true }));

router.get(
  '/info',
  wrap(async (_req, res) => {
    res.json({
      name: 'Ateliê Bela Donzela',
      tagline: 'Estética facial e corporal',
      whatsapp: '5517996213931',
      whatsappDisplay: '(17) 99621-3931',
      instagram: 'estetica_beladonzela',
      address: 'R. Dezenove, 2616 - Jardim Ana Cristina',
      hours: A.describeWeek(await A.loadWeekly()),
    });
  })
);

router.get(
  '/services',
  wrap(async (_req, res) => {
    const services = await prisma.service.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, durationMinutes: true },
    });
    res.json(services);
  })
);

router.get(
  '/availability',
  wrap(async (req, res) => {
    const month = String(req.query.month || '');
    if (!S.isValidMonthStr(month)) throw new HttpError(400, 'Mês inválido. Use AAAA-MM.');

    const total = S.daysInMonth(month);
    const first = `${month}-01`;
    const last = `${month}-${String(total).padStart(2, '0')}`;

    const duration = await durationFor(req.query);
    const ctx = await A.loadContext(first, last);
    const days = [];
    for (let d = 1; d <= total; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      const free = A.dayState(ctx, date, new Date(), duration).free;
      days.push({ date, open: free.length > 0, freeSlots: free.length });
    }
    res.json({ month, days });
  })
);

router.get(
  '/slots',
  wrap(async (req, res) => {
    const date = String(req.query.date || '');
    if (!S.isValidDateStr(date)) throw new HttpError(400, 'Data inválida. Use AAAA-MM-DD.');

    const duration = await durationFor(req.query);
    const ctx = await A.loadContext(date, date);
    const slots = A.dayState(ctx, date, new Date(), duration).free;
    res.json({ date, slots });
  })
);

const bookingSchema = z.object({
  clientName: z
    .string({ required_error: 'Informe seu nome.' })
    .trim()
    .min(2, 'Informe seu nome.')
    .max(80, 'Nome muito longo.'),
  phone: phoneSchema,
  serviceIds: z
    .array(z.number({ invalid_type_error: 'Escolha um serviço.' }).int(), { required_error: 'Escolha ao menos um serviço.', invalid_type_error: 'Escolha ao menos um serviço.' })
    .min(1, 'Escolha ao menos um serviço.')
    .max(100, 'Muitos serviços escolhidos.'),
  date: z.string().refine(S.isValidDateStr, { message: 'Data inválida.' }),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Horário inválido.'),
});

router.post(
  '/appointments',
  writeLimiter,
  wrap(async (req, res) => {
    const raw = req.body && typeof req.body === 'object' ? req.body : {};
    const body = bookingSchema.parse(
      raw.serviceIds === undefined && raw.serviceId !== undefined ? { ...raw, serviceIds: [raw.serviceId] } : raw
    );

    const services = await resolveServices(prisma, body.serviceIds, HttpError);
    const duration = totalDuration(services);
    const names = serviceNames({ services: services.map((service) => ({ service })) });

    const today = S.nowInSaoPaulo().date;
    const active = await prisma.appointment.count({
      where: { phone: body.phone, status: { in: OPEN }, date: { gte: today } },
    });
    if (active >= MAX_ACTIVE_PER_PHONE) {
      throw new HttpError(429, 'Você já tem muitos agendamentos futuros. Cancele algum ou fale conosco.');
    }

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const ctx = await A.loadContext(body.date, body.date, tx);
        const state = A.dayState(ctx, body.date, new Date(), duration);
        if (!state.hours) throw new HttpError(409, 'Este dia está fechado para agendamentos.');
        if (state.limitReached) {
          throw new HttpError(409, 'Os agendamentos deste dia já estão completos. Escolha outra data.');
        }
        if (!state.free.includes(body.time)) {
          throw new HttpError(409, 'Esse horário não está mais disponível. Escolha outro.');
        }
        return tx.appointment.create({
          data: {
            clientName: body.clientName,
            phone: body.phone,
            date: body.date,
            time: body.time,
            serviceId: services[0].id,
            durationMinutes: duration,
            status: 'CONFIRMED',
            slotKey: `${body.date} ${body.time}`,
            services: { create: services.map((s) => ({ serviceId: s.id })) },
          },
          include: WITH_SERVICES,
        });
      });
    } catch (err) {
      if (err && err.code === 'P2002') {
        throw new HttpError(409, 'Esse horário acabou de ser reservado. Escolha outro.');
      }
      throw err;
    }

    const [y, m, d] = created.date.split('-');
    const when = `${d}/${m}/${y} às ${created.time}`;
    await prisma.notification.createMany({
      data: [
        {
          phone: created.phone,
          title: 'Agendamento confirmado',
          message: `Seu agendamento de ${names} para ${when} está confirmado. Esperamos você!`,
        },
        {
          phone: ADMIN_INBOX,
          title: 'Novo agendamento',
          message: `${created.clientName} agendou ${names} para ${when}.`,
        },
      ],
    });

    log.info('agendamento', 'agendamento_criado', { appointmentId: created.id, date: created.date, time: created.time });
    res.status(201).json(publicAppointment(created));
  })
);

router.get(
  '/appointments',
  wrap(async (req, res) => {
    const phone = S.normalizePhone(String(req.query.phone || ''));
    if (!phone) throw new HttpError(400, 'Telefone inválido.');

    const list = await prisma.appointment.findMany({
      where: { phone },
      include: WITH_SERVICES,
      orderBy: [{ date: 'desc' }, { time: 'desc' }],
      take: 100,
    });
    res.json(list.map(publicAppointment));
  })
);

router.post(
  '/appointments/:id/cancel',
  writeLimiter,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const phone = S.normalizePhone(String((req.body && req.body.phone) || ''));
    if (!Number.isInteger(id) || !phone) throw new HttpError(400, 'Dados inválidos.');

    const appt = await prisma.appointment.findUnique({ where: { id }, include: WITH_SERVICES });
    if (!appt || appt.phone !== phone) throw new HttpError(404, 'Agendamento não encontrado.');
    if (!OPEN.includes(appt.status)) throw new HttpError(409, 'Este agendamento não pode mais ser cancelado.');

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status: 'CANCELED', slotKey: null },
      include: WITH_SERVICES,
    });
    const when = `${appt.date.split('-').reverse().join('/')} às ${appt.time}`;
    await prisma.notification.createMany({
      data: [
        { phone, title: 'Agendamento cancelado', message: `Você cancelou ${serviceNames(appt)} de ${when}.` },
        {
          phone: ADMIN_INBOX,
          title: 'Agendamento cancelado pela cliente',
          message: `${appt.clientName} cancelou ${serviceNames(appt)} de ${when}. O horário foi liberado.`,
        },
      ],
    });
    res.json(publicAppointment(updated));
  })
);

router.post(
  '/appointments/clear-inactive',
  writeLimiter,
  wrap(async (req, res) => {
    const phone = S.normalizePhone(String((req.body && req.body.phone) || ''));
    if (!phone) throw new HttpError(400, 'Telefone inválido.');
    const r = await prisma.appointment.deleteMany({ where: { phone, status: { in: INACTIVE } } });
    res.json({ ok: true, deleted: r.count });
  })
);

const presenceSchema = z.object({
  phone: phoneSchema,
  attending: z.boolean({ required_error: 'Informe se você vai comparecer.', invalid_type_error: 'Informe se você vai comparecer.' }),
  reason: z.string().trim().max(200, 'Motivo muito longo.').optional(),
});

router.post(
  '/appointments/:id/presence',
  writeLimiter,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { phone, attending, reason } = presenceSchema.parse(req.body);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Dados inválidos.');
    if (!attending && (!reason || reason.length < 3)) {
      throw new HttpError(400, 'Escreva o motivo para o ateliê saber o que aconteceu.');
    }

    const appt = await prisma.appointment.findUnique({ where: { id }, include: WITH_SERVICES });
    if (!appt || appt.phone !== phone) throw new HttpError(404, 'Agendamento não encontrado.');
    if (appt.status !== 'CONFIRMED' || !appt.reminderSentAt) {
      throw new HttpError(409, 'Este agendamento não está aguardando confirmação de presença.');
    }
    if (appt.date < S.nowInSaoPaulo().date) throw new HttpError(409, 'Este agendamento já passou.');

    const updated = await prisma.appointment.update({
      where: { id },
      data: { presence: attending ? 'YES' : 'NO', presenceReason: attending ? null : reason, presenceAt: new Date() },
      include: WITH_SERVICES,
    });

    const when = `${appt.date.split('-').reverse().join('/')} às ${appt.time}`;
    const adminTitle = attending ? 'Presença confirmada' : 'Cliente não poderá comparecer';
    const adminMessage = attending
      ? `${appt.clientName} confirmou presença: ${serviceNames(appt)}, ${when}.`
      : `${appt.clientName} avisou que não poderá ir: ${serviceNames(appt)}, ${when}. Motivo: ${reason}`;
    await prisma.notification.createMany({
      data: [
        {
          phone,
          title: attending ? 'Presença confirmada' : 'Aviso enviado ao ateliê',
          message: attending
            ? `Obrigada por confirmar! Esperamos você em ${when} (${serviceNames(appt)}).`
            : `Avisamos o ateliê que você não poderá comparecer em ${when}.`,
        },
        { phone: ADMIN_INBOX, title: adminTitle, message: adminMessage },
      ],
    });
    if (!attending) await sendPush([ADMIN_INBOX], { title: adminTitle, body: adminMessage, data: { screen: '/admin' } });

    res.json(publicAppointment(updated));
  })
);

const pushTokenSchema = z.string().trim().regex(/^(Exponent|Expo)PushToken\[[^\]\s]+\]$/, 'Token inválido.');

router.post(
  '/push-token',
  writeLimiter,
  wrap(async (req, res) => {
    const { phone, token } = z.object({ phone: phoneSchema, token: pushTokenSchema }).parse(req.body);
    await prisma.pushToken.upsert({ where: { token }, update: { owner: phone }, create: { token, owner: phone } });
    res.json({ ok: true });
  })
);

router.post(
  '/push-token/remove',
  writeLimiter,
  wrap(async (req, res) => {
    const { token } = z.object({ token: pushTokenSchema }).parse(req.body);
    await prisma.pushToken.deleteMany({ where: { token } });
    res.json({ ok: true });
  })
);

router.get(
  '/notifications',
  wrap(async (req, res) => {
    const phone = S.normalizePhone(String(req.query.phone || ''));
    if (!phone) throw new HttpError(400, 'Telefone inválido.');
    const list = await prisma.notification.findMany({
      where: { phone },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(list);
  })
);

router.post(
  '/notifications/read',
  wrap(async (req, res) => {
    const phone = S.normalizePhone(String((req.body && req.body.phone) || ''));
    if (!phone) throw new HttpError(400, 'Telefone inválido.');
    await prisma.notification.updateMany({ where: { phone, read: false }, data: { read: true } });
    res.json({ ok: true });
  })
);

router.post(
  '/notifications/clear',
  wrap(async (req, res) => {
    const phone = S.normalizePhone(String((req.body && req.body.phone) || ''));
    if (!phone) throw new HttpError(400, 'Telefone inválido.');
    const r = await prisma.notification.deleteMany({ where: { phone } });
    res.json({ ok: true, deleted: r.count });
  })
);

module.exports = router;
