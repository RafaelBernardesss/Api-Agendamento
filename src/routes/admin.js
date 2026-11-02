const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const prisma = require('../db');
const { HttpError, wrap } = require('../lib/http');
const S = require('../lib/schedule');
const { adminNameMatches } = require('../lib/adminName');
const { finishPastAppointments } = require('../lib/finishPast');
const log = require('../lib/logger');
const A = require('../lib/availability');
const { OPEN, ADMIN_INBOX } = require('../lib/status');
const { WITH_SERVICES, serviceList, serviceNames } = require('../lib/appointmentServices');

const router = express.Router();

const AGENDA_STATUSES = ['CONFIRMED'];

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' },
});

function requireAdmin(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Faça login na Área Administrativa.'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('role');
    req.admin = payload;
    return next();
  } catch {
    return next(new HttpError(401, 'Sessão expirada. Entre novamente.'));
  }
}

const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitos pedidos de código. Aguarde 15 minutos.' },
});

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

const credsSchema = z.object({
  phone: z.string({ required_error: 'Informe o telefone.' }).min(1, 'Informe o telefone.'),
  name: z.string({ required_error: 'Informe o nome.' }).trim().min(1, 'Informe o nome.').max(80, 'Nome muito longo.'),
  email: z.string({ required_error: 'Informe o e-mail.' }).trim().toLowerCase().email('E-mail inválido.'),
});

async function findAdmin(phone, email, name) {
  if (!adminNameMatches(name)) return null;
  const normalized = S.normalizePhone(phone);
  if (!normalized) return null;
  const admin = await prisma.admin.findFirst({ where: { phone: normalized } });
  if (!admin || !admin.email || admin.email.toLowerCase() !== email) return null;
  return admin;
}

function hashCode(adminId, code) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${adminId}:${code}`).digest('hex');
}

router.post(
  '/request-code',
  codeLimiter,
  wrap(async (req, res) => {
    const { phone, email, name } = credsSchema.parse(req.body);
    const admin = await findAdmin(phone, email, name);
    if (!admin) log.warn('auth', 'admin_codigo_dados_invalidos', { ip: req.ip });
    if (admin) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await prisma.adminCode.deleteMany({ where: { adminId: admin.id } });
      await prisma.adminCode.create({
        data: { adminId: admin.id, codeHash: hashCode(admin.id, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
      });
      try {
        await require('../lib/mailer').sendAdminCode(admin.email, code);
      } catch (err) {
        console.error('Falha ao enviar e-mail do código:', err.message);
        await prisma.adminCode.deleteMany({ where: { adminId: admin.id } });
        log.error('auth', 'admin_codigo_email_falhou', { ip: req.ip, reason: err.message });
        throw new HttpError(502, 'Não foi possível enviar o e-mail agora. Tente novamente em instantes.');
      }
      log.info('auth', 'admin_codigo_enviado', { ip: req.ip, admin: admin.username });
    }
    res.json({ ok: true, message: 'Se os dados estiverem corretos, enviamos um código de 6 dígitos para o e-mail informado.' });
  })
);

router.post(
  '/verify-code',
  loginLimiter,
  wrap(async (req, res) => {
    const { phone, email, name } = credsSchema.parse(req.body);
    const { code } = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'O código tem 6 dígitos.') }).parse(req.body);

    const invalid = new HttpError(401, 'Código inválido ou expirado.');
    const admin = await findAdmin(phone, email, name);
    if (!admin) {
      log.warn('auth', 'admin_login_dados_invalidos', { ip: req.ip });
      throw invalid;
    }

    const rec = await prisma.adminCode.findFirst({ where: { adminId: admin.id }, orderBy: { createdAt: 'desc' } });
    if (!rec || rec.expiresAt.getTime() < Date.now()) {
      await prisma.adminCode.deleteMany({ where: { adminId: admin.id } });
      throw invalid;
    }
    if (rec.attempts >= MAX_CODE_ATTEMPTS) {
      await prisma.adminCode.deleteMany({ where: { adminId: admin.id } });
      throw new HttpError(401, 'Muitas tentativas erradas. Peça um novo código.');
    }

    const given = Buffer.from(hashCode(admin.id, code));
    const expected = Buffer.from(rec.codeHash);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      await prisma.adminCode.update({ where: { id: rec.id }, data: { attempts: { increment: 1 } } });
      log.warn('auth', 'admin_login_codigo_errado', { ip: req.ip, admin: admin.username });
      throw invalid;
    }

    await prisma.adminCode.deleteMany({ where: { adminId: admin.id } });
    const token = jwt.sign({ role: 'admin', sub: admin.id, username: admin.username }, process.env.JWT_SECRET, {
      expiresIn: '12h',
    });
    log.info('auth', 'admin_login_ok', { ip: req.ip, admin: admin.username });
    res.json({ token, username: admin.username });
  })
);

router.use(requireAdmin);
router.use(require('./config'));
router.use(require('./monitor'));

function adminAppointment(a) {
  return {
    id: a.id,
    clientName: a.clientName,
    phone: a.phone,
    date: a.date,
    time: a.time,
    status: a.status,
    rejectReason: a.rejectReason || undefined,
    needsPresence: S.needsSecondConfirmation(a.createdAt, a.date),
    reminderSent: !!a.reminderSentAt,
    presence: a.presence || undefined,
    presenceReason: a.presenceReason || undefined,
    presenceAt: a.presenceAt || undefined,
    service: serviceNames(a) || undefined,
    services: serviceList(a),
    durationMinutes: a.durationMinutes,
  };
}

router.get(
  '/appointments',
  wrap(async (req, res) => {
    const date = req.query.date ? String(req.query.date) : null;
    if (date && !S.isValidDateStr(date)) throw new HttpError(400, 'Data inválida.');
    const today = S.nowInSaoPaulo().date;
    await finishPastAppointments();

    let where;
    let orderBy = [{ date: 'asc' }, { time: 'asc' }];
    if (req.query.status === 'DONE') {
      where = { status: 'DONE' };
      orderBy = [{ date: 'desc' }, { time: 'asc' }];
    } else if (date) where = { date, status: { in: AGENDA_STATUSES } };
    else where = { date: { gte: today }, status: { in: AGENDA_STATUSES } };
    const list = await prisma.appointment.findMany({ where, include: WITH_SERVICES, orderBy, take: 1000 });
    res.json(list.map(adminAppointment));
  })
);

router.get(
  '/agenda-month',
  wrap(async (req, res) => {
    const month = String(req.query.month || '');
    if (!S.isValidMonthStr(month)) throw new HttpError(400, 'Mês inválido.');
    const from = `${month}-01`;
    const to = `${month}-${String(S.daysInMonth(month)).padStart(2, '0')}`;
    await finishPastAppointments();
    const [appts, blocked, ctx] = await Promise.all([
      prisma.appointment.findMany({ where: { date: { gte: from, lte: to }, status: { in: AGENDA_STATUSES } }, select: { date: true } }),
      prisma.blockedDay.findMany({ where: { date: { gte: from, lte: to } } }),
      A.loadContext(from, to),
    ]);
    const counts = {};
    for (const a of appts) counts[a.date] = (counts[a.date] || 0) + 1;
    const closed = [];
    for (let d = 1; d <= S.daysInMonth(month); d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      if (!A.hoursFor(ctx, date)) closed.push(date);
    }
    res.json({
      month,
      counts,
      blocked: blocked.map((b) => b.date),
      closed,
    });
  })
);

router.delete(
  '/appointments/done',
  wrap(async (_req, res) => {
    await finishPastAppointments();
    const r = await prisma.appointment.deleteMany({ where: { status: 'DONE' } });
    res.json({ ok: true, deleted: r.count });
  })
);

router.post(
  '/appointments/done/bulk-delete',
  wrap(async (req, res) => {
    const { ids } = z
      .object({ ids: z.array(z.number().int()).min(1, 'Selecione ao menos um agendamento.').max(1000) })
      .parse(req.body);
    const r = await prisma.appointment.deleteMany({ where: { id: { in: ids }, status: 'DONE' } });
    res.json({ ok: true, deleted: r.count });
  })
);

router.patch(
  '/appointments/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    z.object({ status: z.literal('CANCELED', { errorMap: () => ({ message: 'O agendamento só pode ser cancelado.' }) }) }).parse(req.body);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Identificador inválido.');

    const appt = await prisma.appointment.findUnique({ where: { id }, include: WITH_SERVICES });
    if (!appt) throw new HttpError(404, 'Agendamento não encontrado.');
    if (appt.status === 'CANCELED') return res.json(adminAppointment(appt));
    if (!OPEN.includes(appt.status)) throw new HttpError(409, 'Só é possível cancelar agendamentos ativos.');

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status: 'CANCELED', slotKey: null, rejectReason: null },
      include: WITH_SERVICES,
    });

    log.info('admin', 'agendamento_cancelado_pelo_admin', { appointmentId: id, admin: req.admin.username });
    const when = `${appt.date.split('-').reverse().join('/')} às ${appt.time}`;
    await prisma.notification.create({
      data: {
        phone: appt.phone,
        title: 'Agendamento cancelado',
        message: `Seu agendamento de ${serviceNames(appt)} (${when}) foi cancelado pelo ateliê.`,
      },
    });
    res.json(adminAppointment(updated));
  })
);

router.get(
  '/blocked-days',
  wrap(async (_req, res) => {
    const today = S.nowInSaoPaulo().date;
    res.json(await prisma.blockedDay.findMany({ where: { date: { gte: today } }, orderBy: { date: 'asc' } }));
  })
);

router.post(
  '/blocked-days',
  wrap(async (req, res) => {
    const { date, reason } = z
      .object({ date: z.string().refine(S.isValidDateStr, { message: 'Data inválida.' }), reason: z.string().max(120).optional() })
      .parse(req.body);

    const day = await prisma.blockedDay.upsert({
      where: { date },
      update: { reason: reason || null },
      create: { date, reason: reason || null },
    });
    const affected = await prisma.appointment.count({ where: { date, status: { in: OPEN } } });
    res.status(201).json({ ...day, confirmedAppointments: affected });
  })
);

router.delete(
  '/blocked-days/:date',
  wrap(async (req, res) => {
    const date = String(req.params.date);
    if (!S.isValidDateStr(date)) throw new HttpError(400, 'Data inválida.');
    await prisma.blockedDay.deleteMany({ where: { date } });
    res.json({ ok: true });
  })
);

router.get(
  '/services',
  wrap(async (_req, res) => {
    res.json(await prisma.service.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }));
  })
);

router.post(
  '/services',
  wrap(async (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(2, 'Informe o nome.').max(60) }).parse(req.body);
    try {
      res.status(201).json(await prisma.service.create({ data: { name } }));
    } catch (err) {
      if (err && err.code === 'P2002') throw new HttpError(409, 'Já existe um serviço com esse nome.');
      throw err;
    }
  })
);

router.patch(
  '/services/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const data = z
      .object({
        name: z.string().trim().min(2).max(60).optional(),
        active: z.boolean().optional(),
        durationMinutes: z.number().int().min(5, 'A duração mínima é 5 minutos.').max(720, 'A duração máxima é 12 horas.').optional(),
      })
      .parse(req.body);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Identificador inválido.');
    try {
      res.json(await prisma.service.update({ where: { id }, data }));
    } catch (err) {
      if (err && err.code === 'P2025') throw new HttpError(404, 'Serviço não encontrado.');
      if (err && err.code === 'P2002') throw new HttpError(409, 'Já existe um serviço com esse nome.');
      throw err;
    }
  })
);

router.get(
  '/summary',
  wrap(async (_req, res) => {
    const unreadNotifications = await prisma.notification.count({ where: { phone: ADMIN_INBOX, read: false } });
    res.json({ unreadNotifications });
  })
);

router.get(
  '/notifications',
  wrap(async (_req, res) => {
    res.json(await prisma.notification.findMany({ where: { phone: ADMIN_INBOX }, orderBy: { createdAt: 'desc' }, take: 50 }));
  })
);

router.post(
  '/notifications/read',
  wrap(async (_req, res) => {
    await prisma.notification.updateMany({ where: { phone: ADMIN_INBOX, read: false }, data: { read: true } });
    res.json({ ok: true });
  })
);

router.post(
  '/notifications/clear',
  wrap(async (_req, res) => {
    const r = await prisma.notification.deleteMany({ where: { phone: ADMIN_INBOX } });
    res.json({ ok: true, deleted: r.count });
  })
);

const adminPushToken = z.string().trim().regex(/^(Exponent|Expo)PushToken\[[^\]\s]+\]$/, 'Token inválido.');

router.post(
  '/push-token',
  wrap(async (req, res) => {
    const { token } = z.object({ token: adminPushToken }).parse(req.body);
    await prisma.pushToken.upsert({ where: { token }, update: { owner: ADMIN_INBOX }, create: { token, owner: ADMIN_INBOX } });
    res.json({ ok: true });
  })
);

router.post(
  '/push-token/remove',
  wrap(async (req, res) => {
    const { token } = z.object({ token: adminPushToken }).parse(req.body);
    await prisma.pushToken.deleteMany({ where: { token, owner: ADMIN_INBOX } });
    res.json({ ok: true });
  })
);

module.exports = router;
