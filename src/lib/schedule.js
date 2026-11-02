const TIME_ZONE = 'America/Sao_Paulo';
const SLOT_MINUTES = 60;
const SLOT_STEP_MINUTES = 30;

const BUSINESS_HOURS = {
  0: null,
  1: { open: '07:00', close: '18:00' },
  2: { open: '07:00', close: '18:00' },
  3: { open: '07:00', close: '18:00' },
  4: { open: '07:00', close: '18:00' },
  5: { open: '07:00', close: '18:00' },
  6: { open: '07:00', close: '12:00' },
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(total) {
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidMonthStr(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function nowInSaoPaulo(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTime(s) {
  return typeof s === 'string' && TIME_RE.test(s);
}

function defaultHoursFor(dateStr) {
  const h = BUSINESS_HOURS[weekdayOf(dateStr)];
  return h ? { open: h.open, close: h.close, lunchStart: null, lunchEnd: null } : null;
}

function validateHours(h) {
  if (!h || !isValidTime(h.open) || !isValidTime(h.close)) return 'Informe o horário de entrada e de saída.';
  if (toMinutes(h.open) >= toMinutes(h.close)) return 'A saída precisa ser depois da entrada.';
  const hasStart = h.lunchStart !== null && h.lunchStart !== undefined;
  const hasEnd = h.lunchEnd !== null && h.lunchEnd !== undefined;
  if (hasStart !== hasEnd) return 'Informe o início e o fim do almoço.';
  if (hasStart) {
    if (!isValidTime(h.lunchStart) || !isValidTime(h.lunchEnd)) return 'Horário de almoço inválido.';
    if (toMinutes(h.lunchStart) >= toMinutes(h.lunchEnd)) return 'O almoço precisa terminar depois de começar.';
    if (toMinutes(h.lunchStart) < toMinutes(h.open) || toMinutes(h.lunchEnd) > toMinutes(h.close)) {
      return 'O almoço precisa estar dentro do horário de trabalho.';
    }
  }
  return null;
}

function allSlotsForDate(dateStr, hours = defaultHoursFor(dateStr), duration) {
  if (!hours) return [];
  const len = duration || SLOT_MINUTES;
  const step = duration ? SLOT_STEP_MINUTES : SLOT_MINUTES;
  const slots = [];
  const end = toMinutes(hours.close);
  const lunchStart = hours.lunchStart ? toMinutes(hours.lunchStart) : null;
  const lunchEnd = hours.lunchEnd ? toMinutes(hours.lunchEnd) : null;
  for (let t = toMinutes(hours.open); t + len <= end; t += step) {
    if (lunchStart !== null && lunchEnd !== null && t < lunchEnd && t + len > lunchStart) continue;
    slots.push(fromMinutes(t));
  }
  return slots;
}

function bookingRange(b) {
  const time = typeof b === 'string' ? b : b.time;
  const len = typeof b === 'string' ? SLOT_MINUTES : Number(b.durationMinutes) || SLOT_MINUTES;
  const start = toMinutes(time);
  return [start, start + len];
}

function overlaps(a1, a2, b1, b2) {
  return a1 < b2 && b1 < a2;
}

function freeSlots(dateStr, bookings, now = new Date(), hours = defaultHoursFor(dateStr), duration) {
  const today = nowInSaoPaulo(now);
  if (dateStr < today.date) return [];
  const len = duration || SLOT_MINUTES;
  const ranges = bookings.map(bookingRange);
  return allSlotsForDate(dateStr, hours, duration).filter((t) => {
    const start = toMinutes(t);
    if (ranges.some(([s, e]) => overlaps(start, start + len, s, e))) return false;
    if (dateStr === today.date && start <= today.minutes) return false;
    return true;
  });
}

function daysInMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let digits = input.replace(/\D/g, '');
  if (digits.length > 11 && digits.startsWith('55')) digits = digits.slice(2);
  if (digits.length !== 10 && digits.length !== 11) return null;
  if (digits.length === 11 && digits[2] !== '9') return null;
  return digits;
}

function createdDateInSaoPaulo(createdAt) {
  return nowInSaoPaulo(new Date(createdAt)).date;
}

function diffDays(fromStr, toStr) {
  const a = fromStr.split('-').map(Number);
  const b = toStr.split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}

const MIN_DAYS_FOR_SECOND_CONFIRMATION = 2;
function needsSecondConfirmation(createdAt, dateStr) {
  if (!createdAt) return false;
  return diffDays(createdDateInSaoPaulo(createdAt), dateStr) >= MIN_DAYS_FOR_SECOND_CONFIRMATION;
}

module.exports = {
  needsSecondConfirmation,
  diffDays,
  TIME_ZONE,
  SLOT_MINUTES,
  SLOT_STEP_MINUTES,
  bookingRange,
  overlaps,
  BUSINESS_HOURS,
  isValidDateStr,
  isValidMonthStr,
  weekdayOf,
  nowInSaoPaulo,
  isValidTime,
  defaultHoursFor,
  validateHours,
  allSlotsForDate,
  freeSlots,
  daysInMonth,
  normalizePhone,
  toMinutes,
  fromMinutes,
};
