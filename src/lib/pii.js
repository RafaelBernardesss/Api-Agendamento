const { encryptRandom, encryptDet, decrypt, isEncrypted } = require('./crypto');

const FIELDS = {
  Appointment: { clientName: 'random', phone: 'det', rejectReason: 'random', presenceReason: 'random' },
  User: { name: 'random', phone: 'det' },
  Notification: { phone: 'det', message: 'random' },
  PushToken: { token: 'det', owner: 'det' },
  Admin: { phone: 'det', email: 'random' },
};

const LOGIC = ['AND', 'OR', 'NOT'];
const EQUALITY_OPS = ['equals', 'in', 'notIn', 'not'];

function enc(kind, v) {
  return kind === 'det' ? encryptDet(v) : encryptRandom(v);
}

function encWhere(model, where) {
  if (!where || typeof where !== 'object') return where;
  if (Array.isArray(where)) return where.map((w) => encWhere(model, w));
  const map = FIELDS[model] || {};
  const out = {};
  for (const [key, val] of Object.entries(where)) {
    if (LOGIC.includes(key)) out[key] = encWhere(model, val);
    else if (map[key]) {
      if (map[key] !== 'det') throw new Error(`Campo ${model}.${key} é criptografado e não pode ser usado em filtro.`);
      if (val === null || typeof val === 'string') out[key] = enc('det', val);
      else if (val && typeof val === 'object') {
        const f = {};
        for (const [op, x] of Object.entries(val)) {
          if (!EQUALITY_OPS.includes(op)) throw new Error(`Filtro "${op}" não funciona em ${model}.${key} (criptografado).`);
          f[op] = Array.isArray(x) ? x.map((i) => enc('det', i)) : x && typeof x === 'object' ? x : enc('det', x);
        }
        out[key] = f;
      } else out[key] = val;
    } else out[key] = val;
  }
  return out;
}

function encData(model, data) {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map((d) => encData(model, d));
  const map = FIELDS[model] || {};
  const out = { ...data };
  for (const [key, kind] of Object.entries(map)) {
    if (!(key in out)) continue;
    const v = out[key];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') out[key] = enc(kind, v);
    else if (v && typeof v === 'object' && typeof v.set === 'string') out[key] = { ...v, set: enc(kind, v.set) };
  }
  return out;
}

function decResult(value) {
  if (typeof value === 'string') return isEncrypted(value) ? decrypt(value) : value;
  if (Array.isArray(value)) return value.map(decResult);
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decResult(v);
    return out;
  }
  return value;
}

module.exports = { FIELDS, encWhere, encData, decResult };
