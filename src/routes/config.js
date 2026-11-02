const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { HttpError, wrap } = require('../lib/http');
const S = require('../lib/schedule');
const A = require('../lib/availability');
const { OPEN } = require('../lib/status');

const router = express.Router();

const MAX_DAYS_AHEAD = 366;

const dateSchema = z.string().refine(S.isValidDateStr, { message: 'Data inválida.' });
const timeSchema = z.string().refine(S.isValidTime, { message: 'Horário inválido. Use HH:mm.' });
const optionalTime = timeSchema.nullable().optional();

const hoursSchema = z
  .object({ open: timeSchema, close: timeSchema, lunchStart: optionalTime, lunchEnd: optionalTime })
  .transform((h) => ({ open: h.open, close: h.close, lunchStart: h.lunchStart || null, lunchEnd: h.lunchEnd || null }))
  .superRefine((h, ctx) => {
    const err = S.validateHours(h);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
  });

function assertEditableDate(date) {
  if (date < S.nowInSaoPaulo().date) throw new HttpError(400, 'Não é possível alterar uma data que já passou.');
}

router.get(
  '/work-hours',
  wrap(async (_req, res) => {
    res.json(await A.loadWeekly());
  })
);

const weeklySchema = z
  .array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      works: z.boolean(),
      open: z.string(),
      close: z.string(),
      lunchStart: z.string().nullable().optional(),
      lunchEnd: z.string().nullable().optional(),
    })
  )
  .length(7, 'Envie os 7 dias da semana.');

router.put(
  '/work-hours',
  wrap(async (req, res) => {
    const days = weeklySchema.parse(req.body);
    const seen = new Set(days.map((d) => d.weekday));
    if (seen.size !== 7) throw new HttpError(400, 'Envie cada dia da semana uma única vez.');

    const names = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    const rows = days.map((d) => {
      const hours = { open: d.open, close: d.close, lunchStart: d.lunchStart || null, lunchEnd: d.lunchEnd || null };
      if (d.works) {
        const err = S.validateHours(hours);
        if (err) throw new HttpError(400, `${names[d.weekday][0].toUpperCase()}${names[d.weekday].slice(1)}: ${err}`);
        return { weekday: d.weekday, works: true, ...hours };
      }
      const keep = S.validateHours(hours) === null ? hours : { open: A.DEFAULT_OPEN, close: A.DEFAULT_CLOSE, lunchStart: null, lunchEnd: null };
      return { weekday: d.weekday, works: false, ...keep };
    });

    await prisma.$transaction(
      rows.map((r) => prisma.workHours.upsert({ where: { weekday: r.weekday }, update: r, create: r }))
    );
    res.json(await A.loadWeekly());
  })
);

async function dayConfig(date) {
  const ctx = await A.loadContext(date, date);
  const weekly = A.weeklyHoursFor(ctx, date);
  const special = ctx.dayHours.get(date);
  const blocked = ctx.blocked.has(date);
  const hours = A.hoursFor(ctx, date);
  const active = await prisma.appointment.count({ where: { date, status: { in: OPEN } } });
  return {
    date,
    works: !!hours,
    hours: hours || (special ? A.hoursOf(special) : weekly) || { open: A.DEFAULT_OPEN, close: A.DEFAULT_CLOSE, lunchStart: null, lunchEnd: null },
    weekly,
    custom: !blocked && !!special,
    activeAppointments: active,
  };
}

router.get(
  '/day-config',
  wrap(async (req, res) => {
    const date = String(req.query.date || '');
    if (!S.isValidDateStr(date)) throw new HttpError(400, 'Data inválida.');
    res.json(await dayConfig(date));
  })
);

const dayBodySchema = z.object({ works: z.boolean(), hours: hoursSchema.optional() });

router.put(
  '/day-config/:date',
  wrap(async (req, res) => {
    const date = String(req.params.date);
    if (!S.isValidDateStr(date)) throw new HttpError(400, 'Data inválida.');
    assertEditableDate(date);
    const { works, hours } = dayBodySchema.parse(req.body);

    if (!works) {
      await prisma.$transaction([
        prisma.blockedDay.upsert({ where: { date }, update: {}, create: { date } }),
        prisma.dayHours.deleteMany({ where: { date } }),
      ]);
    } else {
      const ctx = await A.loadContext(date, date);
      const weekly = A.weeklyHoursFor(ctx, date);
      if (!hours && !weekly) throw new HttpError(400, 'Informe o horário de trabalho deste dia.');
      const same = !!hours && !!weekly && ['open', 'close', 'lunchStart', 'lunchEnd'].every((k) => hours[k] === weekly[k]);
      const ops = [prisma.blockedDay.deleteMany({ where: { date } })];
      if (!hours || same) ops.push(prisma.dayHours.deleteMany({ where: { date } }));
      else ops.push(prisma.dayHours.upsert({ where: { date }, update: hours, create: { date, ...hours } }));
      await prisma.$transaction(ops);
    }
    res.json(await dayConfig(date));
  })
);

async function limitConfig(date) {
  const ctx = await A.loadContext(date, date);
  const limit = A.limitInfo(ctx, date);
  const total = (ctx.bookedByDate.get(date) || []).length;
  return {
    date,
    max: limit ? limit.max : null,
    used: limit ? limit.used : 0,
    remaining: limit ? limit.remaining : null,
    before: limit ? total - limit.used : total,
  };
}

router.get(
  '/day-limit',
  wrap(async (req, res) => {
    const date = String(req.query.date || '');
    if (!S.isValidDateStr(date)) throw new HttpError(400, 'Data inválida.');
    res.json(await limitConfig(date));
  })
);

router.put(
  '/day-limit/:date',
  wrap(async (req, res) => {
    const date = String(req.params.date);
    if (!S.isValidDateStr(date)) throw new HttpError(400, 'Data inválida.');
    assertEditableDate(date);
    const { max } = z
      .object({ max: z.number({ invalid_type_error: 'Informe um número.' }).int('Informe um número inteiro.').min(1, 'O mínimo é 1.').max(200, 'O máximo é 200.') })
      .parse(req.body);

    await prisma.$transaction(async (tx) => {
      const existing = await tx.dayLimit.findUnique({ where: { date } });
      if (existing) {
        await tx.dayLimit.update({ where: { date }, data: { max } });
      } else {
        const last = await tx.appointment.aggregate({ _max: { id: true } });
        await tx.dayLimit.create({ data: { date, max, afterId: last._max.id || 0 } });
      }
    });
    res.json(await limitConfig(date));
  })
);

router.delete(
  '/day-limit/:date',
  wrap(async (req, res) => {
    const date = String(req.params.date);
    if (!S.isValidDateStr(date)) throw new HttpError(400, 'Data inválida.');
    await prisma.dayLimit.deleteMany({ where: { date } });
    res.json(await limitConfig(date));
  })
);

router.get(
  '/config-month',
  wrap(async (req, res) => {
    const month = String(req.query.month || '');
    if (!S.isValidMonthStr(month)) throw new HttpError(400, 'Mês inválido.');
    const from = `${month}-01`;
    const to = `${month}-${String(S.daysInMonth(month)).padStart(2, '0')}`;
    const ctx = await A.loadContext(from, to);

    const closed = [];
    const custom = [];
    const limits = {};
    for (let d = 1; d <= S.daysInMonth(month); d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      if (!A.hoursFor(ctx, date)) closed.push(date);
      else if (ctx.dayHours.has(date)) custom.push(date);
      const info = A.limitInfo(ctx, date);
      if (info) limits[date] = info;
    }
    res.json({ month, closed, custom, limits });
  })
);

module.exports = router;
