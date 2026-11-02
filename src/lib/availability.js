const defaultDb = () => require('../db');
const S = require('./schedule');
const { INACTIVE } = require('./status');

const DEFAULT_OPEN = '07:00';
const DEFAULT_CLOSE = '18:00';

function hoursOf(row) {
  return { open: row.open, close: row.close, lunchStart: row.lunchStart || null, lunchEnd: row.lunchEnd || null };
}

async function loadWeekly(db = defaultDb()) {
  const rows = await db.workHours.findMany();
  const byDay = new Map(rows.map((r) => [r.weekday, r]));
  return Array.from({ length: 7 }, (_, weekday) => {
    const r = byDay.get(weekday);
    if (r) return { weekday, works: r.works, ...hoursOf(r) };
    const d = S.BUSINESS_HOURS[weekday];
    return { weekday, works: !!d, open: d ? d.open : DEFAULT_OPEN, close: d ? d.close : DEFAULT_CLOSE, lunchStart: null, lunchEnd: null };
  });
}

async function loadContext(from, to, db = defaultDb()) {
  const range = { gte: from, lte: to };
  const [weekly, blocked, dayHours, limits, appts] = await Promise.all([
    loadWeekly(db),
    db.blockedDay.findMany({ where: { date: range } }),
    db.dayHours.findMany({ where: { date: range } }),
    db.dayLimit.findMany({ where: { date: range } }),
    db.appointment.findMany({ where: { date: range, status: { notIn: INACTIVE } }, select: { id: true, date: true, time: true, durationMinutes: true } }),
  ]);
  const bookedByDate = new Map();
  for (const a of appts) {
    if (!bookedByDate.has(a.date)) bookedByDate.set(a.date, []);
    bookedByDate.get(a.date).push(a);
  }
  return {
    weekly,
    blocked: new Set(blocked.map((b) => b.date)),
    dayHours: new Map(dayHours.map((d) => [d.date, d])),
    limits: new Map(limits.map((l) => [l.date, l])),
    bookedByDate,
  };
}

function weeklyHoursFor(ctx, date) {
  const w = ctx.weekly[S.weekdayOf(date)];
  return w.works ? hoursOf(w) : null;
}

function hoursFor(ctx, date) {
  if (ctx.blocked.has(date)) return null;
  const special = ctx.dayHours.get(date);
  if (special) return hoursOf(special);
  return weeklyHoursFor(ctx, date);
}

function limitInfo(ctx, date) {
  const limit = ctx.limits.get(date);
  if (!limit) return null;
  const used = (ctx.bookedByDate.get(date) || []).filter((a) => a.id > limit.afterId).length;
  return { max: limit.max, used, remaining: Math.max(0, limit.max - used) };
}

function dayState(ctx, date, now = new Date(), duration) {
  const hours = hoursFor(ctx, date);
  const limit = limitInfo(ctx, date);
  const limitReached = !!limit && limit.remaining === 0;
  const booked = ctx.bookedByDate.get(date) || [];
  const free = !hours || limitReached ? [] : S.freeSlots(date, booked, now, hours, duration);
  return { hours, limit, limitReached, free };
}

async function findConflict(appt, db = defaultDb()) {
  const [s, e] = S.bookingRange(appt);
  const others = await db.appointment.findMany({
    where: { date: appt.date, status: { notIn: INACTIVE }, id: { not: appt.id } },
    select: { id: true, time: true, durationMinutes: true },
  });
  return others.find((o) => {
    const [os, oe] = S.bookingRange(o);
    return S.overlaps(s, e, os, oe);
  }) || null;
}

const DAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function describeWeek(weekly) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const valueOf = (w) =>
    !w.works
      ? 'Fechado'
      : `${w.open} – ${w.close}` + (w.lunchStart && w.lunchEnd ? ` (almoço ${w.lunchStart} – ${w.lunchEnd})` : '');
  const groups = [];
  for (const wd of order) {
    const value = valueOf(weekly[wd]);
    const last = groups[groups.length - 1];
    if (last && last.value === value) last.days.push(wd);
    else groups.push({ value, days: [wd] });
  }
  return groups.map(({ value, days }) => {
    const first = DAY_NAMES[days[0]];
    const lastName = DAY_NAMES[days[days.length - 1]];
    const label = days.length === 1 ? first : days.length === 2 ? `${first} e ${lastName}` : `${first} a ${lastName}`;
    return { label: days.length === 1 && days[0] === 6 ? 'Sábado' : label, value };
  });
}

module.exports = {
  describeWeek, loadWeekly, loadContext, findConflict, weeklyHoursFor, hoursFor, limitInfo, dayState, hoursOf, DEFAULT_OPEN, DEFAULT_CLOSE };
