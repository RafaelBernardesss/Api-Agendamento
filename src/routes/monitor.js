const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const prisma = require('../db');
const { HttpError, wrap } = require('../lib/http');
const S = require('../lib/schedule');
const log = require('../lib/logger');
const { WITH_SERVICES, serviceList, serviceNames } = require('../lib/appointmentServices');
const { finishPastAppointments } = require('../lib/finishPast');

const router = express.Router();

const STATUSES = ['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELED', 'DONE'];

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas consultas. Aguarde um minuto.' },
});

const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

router.use(['/users', '/monitor'], limiter, noStore);

function parse(schema, query) {
  const r = schema.safeParse(query);
  if (!r.success) throw new HttpError(400, (r.error.issues[0] && r.error.issues[0].message) || 'Parâmetros inválidos.');
  return r.data;
}

const pagingShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

function paginate(list, page, pageSize) {
  const total = list.length;
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items: list.slice((page - 1) * pageSize, page * pageSize),
  };
}

function stageOf(a) {
  if (a.status === 'PENDING') return { code: 'PENDING', label: 'Aguardando confirmação do ateliê' };
  if (a.status === 'REJECTED') return { code: 'REJECTED', label: 'Recusado' };
  if (a.status === 'CANCELED') return { code: 'CANCELED', label: 'Cancelado' };
  if (a.status === 'DONE') return { code: 'DONE', label: 'Atendimento concluído' };
  if (a.presence === 'YES') return { code: 'PRESENCE_CONFIRMED', label: 'Presença confirmada pela cliente' };
  if (a.presence === 'NO') return { code: 'ABSENCE_WARNED', label: 'Cliente avisou que não poderá ir' };
  if (a.reminderSentAt) return { code: 'AWAITING_PRESENCE', label: 'Lembrete enviado, aguardando resposta' };
  return { code: 'SCHEDULED', label: 'Agendado e confirmado' };
}

function progress(a) {
  const timeline = [{ step: 'CREATED', label: 'Agendamento criado', at: a.createdAt }];
  if (a.reminderSentAt) timeline.push({ step: 'REMINDER_SENT', label: 'Lembrete de 1 dia antes enviado', at: a.reminderSentAt });
  if (a.presence === 'YES') timeline.push({ step: 'PRESENCE_YES', label: 'Cliente confirmou presença', at: a.presenceAt || null });
  if (a.presence === 'NO') {
    timeline.push({ step: 'PRESENCE_NO', label: 'Cliente avisou que não poderá ir', at: a.presenceAt || null, reason: a.presenceReason || null });
  }
  if (a.status === 'REJECTED') timeline.push({ step: 'REJECTED', label: 'Recusado pelo ateliê', at: null, reason: a.rejectReason || null });
  if (a.status === 'CANCELED') timeline.push({ step: 'CANCELED', label: 'Cancelado', at: null });
  if (a.status === 'DONE') timeline.push({ step: 'DONE', label: 'Atendimento concluído', at: null });
  return timeline;
}

function monitorAppointment(a) {
  return {
    id: a.id,
    clientName: a.clientName,
    phone: a.phone,
    date: a.date,
    time: a.time,
    durationMinutes: a.durationMinutes,
    status: a.status,
    stage: stageOf(a),
    services: serviceList(a),
    service: serviceNames(a) || null,
    needsPresence: S.needsSecondConfirmation(a.createdAt, a.date),
    reminderSentAt: a.reminderSentAt || null,
    presence: a.presence || null,
    presenceReason: a.presenceReason || null,
    presenceAt: a.presenceAt || null,
    rejectReason: a.rejectReason || null,
    createdAt: a.createdAt,
    timeline: progress(a),
  };
}

function countByStatus(list) {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const a of list) out[a.status] = (out[a.status] || 0) + 1;
  return out;
}

router.get(
  '/users',
  wrap(async (req, res) => {
    const { q, sort, page, pageSize } = parse(
      z.object({
        q: z.string().trim().max(80).optional(),
        sort: z.enum(['recent', 'name']).default('recent'),
        ...pagingShape,
      }),
      req.query
    );
    await finishPastAppointments();
    const today = S.nowInSaoPaulo().date;
    const [users, appts] = await Promise.all([
      prisma.user.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.appointment.findMany({ select: { phone: true, status: true, date: true, time: true } }),
    ]);

    const byPhone = new Map();
    for (const a of appts) {
      if (!byPhone.has(a.phone)) byPhone.set(a.phone, []);
      byPhone.get(a.phone).push(a);
    }

    let rows = users.map((u) => {
      const mine = byPhone.get(u.phone) || [];
      const upcoming = mine
        .filter((a) => a.status === 'CONFIRMED' && a.date >= today)
        .sort((x, y) => `${x.date} ${x.time}`.localeCompare(`${y.date} ${y.time}`))[0];
      return {
        id: u.id,
        name: u.name,
        phone: u.phone,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        appointments: { total: mine.length, ...countByStatus(mine) },
        nextAppointment: upcoming ? { date: upcoming.date, time: upcoming.time } : null,
      };
    });

    if (q) {
      const needle = fold(q);
      const digits = q.replace(/\D/g, '');
      rows = rows.filter((u) => fold(u.name).includes(needle) || (digits && u.phone.includes(digits)));
    }
    if (sort === 'name') rows.sort((a, b) => fold(a.name).localeCompare(fold(b.name)));

    res.json(paginate(rows, page, pageSize));
  })
);

router.get(
  '/users/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Identificador inválido.');
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new HttpError(404, 'Usuário não encontrado.');
    await finishPastAppointments();
    const list = await prisma.appointment.findMany({
      where: { phone: user.phone },
      include: WITH_SERVICES,
      orderBy: [{ date: 'desc' }, { time: 'asc' }],
    });
    res.json({
      id: user.id,
      name: user.name,
      phone: user.phone,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      appointments: { total: list.length, ...countByStatus(list) },
      items: list.map(monitorAppointment),
    });
  })
);

router.get(
  '/monitor/overview',
  wrap(async (_req, res) => {
    await finishPastAppointments();
    const today = S.nowInSaoPaulo().date;
    const [users, appts] = await Promise.all([
      prisma.user.count(),
      prisma.appointment.findMany({ select: { status: true, date: true, presence: true, reminderSentAt: true } }),
    ]);
    const confirmedFuture = appts.filter((a) => a.status === 'CONFIRMED' && a.date >= today);
    res.json({
      users,
      appointments: { total: appts.length, ...countByStatus(appts) },
      today: appts.filter((a) => a.status === 'CONFIRMED' && a.date === today).length,
      upcoming: confirmedFuture.length,
      awaitingPresence: confirmedFuture.filter((a) => a.reminderSentAt && !a.presence).length,
      absenceWarnings: confirmedFuture.filter((a) => a.presence === 'NO').length,
      generatedAt: new Date().toISOString(),
    });
  })
);

router.get(
  '/monitor/appointments',
  wrap(async (req, res) => {
    const dateStr = z
      .string()
      .refine((v) => S.isValidDateStr(v), 'Data inválida. Use AAAA-MM-DD.')
      .optional();
    const { status, from, to, q, stage, sort, page, pageSize } = parse(
      z.object({
        status: z.string().optional(),
        from: dateStr,
        to: dateStr,
        q: z.string().trim().max(80).optional(),
        stage: z.string().trim().max(40).optional(),
        sort: z.enum(['asc', 'desc']).default('desc'),
        ...pagingShape,
      }),
      req.query
    );

    let statuses = null;
    if (status) {
      statuses = status.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (statuses.some((s) => !STATUSES.includes(s))) throw new HttpError(400, 'Status inválido.');
    }

    await finishPastAppointments();
    const where = {};
    if (statuses) where.status = { in: statuses };
    if (from || to) where.date = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

    const list = await prisma.appointment.findMany({
      where,
      include: WITH_SERVICES,
      orderBy: [{ date: sort }, { time: sort }],
      take: 5000,
    });

    let items = list.map(monitorAppointment);
    if (stage) items = items.filter((a) => a.stage.code === stage.toUpperCase());
    if (q) {
      const needle = fold(q);
      const digits = q.replace(/\D/g, '');
      items = items.filter(
        (a) => fold(a.clientName).includes(needle) || fold(a.service).includes(needle) || (digits && a.phone.includes(digits))
      );
    }

    res.json({ summary: countByStatus(items), ...paginate(items, page, pageSize) });
  })
);

router.get(
  '/monitor/logs',
  wrap(async (req, res) => {
    const iso = z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), 'Data inválida. Use o formato AAAA-MM-DDTHH:mm.')
      .optional();
    const { level, type, q, since, until, limit, offset } = parse(
      z.object({
        level: z.enum(['info', 'warn', 'error']).optional(),
        type: z.string().trim().max(30).optional(),
        q: z.string().trim().max(80).optional(),
        since: iso,
        until: iso,
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query
    );
    log.info('admin', 'logs_consultados', { admin: req.admin.username, ip: req.ip });
    res.json(log.query({ level, type, q, since, until, limit, offset }));
  })
);

module.exports = router;
