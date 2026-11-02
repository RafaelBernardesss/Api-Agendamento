const fs = require('fs');
const path = require('path');

const MAX_MEMORY = 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const READ_BYTES = 2 * 1024 * 1024;
const FLUSH_MS = 1000;

const dir = path.resolve(process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'));
const file = path.join(dir, 'app.log');
const memory = [];
let pending = [];
let fileOk = true;
let writes = 0;

try {
  fs.mkdirSync(dir, { recursive: true });
} catch {
  fileOk = false;
}

function rotateIfNeeded() {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {}
}

function flush() {
  if (!fileOk || pending.length === 0) return;
  const chunk = pending.map((e) => JSON.stringify(e)).join('\n') + '\n';
  pending = [];
  try {
    fs.appendFileSync(file, chunk);
    writes += 1;
    if (writes % 50 === 0) rotateIfNeeded();
  } catch {
    fileOk = false;
  }
}

const timer = setInterval(flush, FLUSH_MS);
timer.unref();
process.on('exit', flush);

function write(level, type, message, meta) {
  const entry = { time: new Date().toISOString(), level, type, message: String(message).slice(0, 500) };
  if (meta && typeof meta === 'object') {
    for (const [k, v] of Object.entries(meta)) {
      if (v !== undefined && !['token', 'authorization', 'code', 'password'].includes(k)) entry[k] = v;
    }
  }
  memory.push(entry);
  if (memory.length > MAX_MEMORY) memory.shift();
  if (fileOk) pending.push(entry);
  return entry;
}

function tail(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    const length = Math.min(size, READ_BYTES);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      const lines = buf.toString('utf8').split('\n');
      if (size > length) lines.shift();
      return lines;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function load() {
  if (!fileOk) return memory.slice();
  flush();
  const lines = [...tail(`${file}.1`), ...tail(file)];
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function query({ level, type, q, since, until, limit = 100, offset = 0 } = {}) {
  const needle = q ? String(q).toLowerCase() : null;
  const sinceMs = since ? Date.parse(since) : null;
  const untilMs = until ? Date.parse(until) : null;
  const filtered = load()
    .filter((e) => {
      if (level && e.level !== level) return false;
      if (type && e.type !== type) return false;
      const t = Date.parse(e.time);
      if (sinceMs && t < sinceMs) return false;
      if (untilMs && t > untilMs) return false;
      if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) return false;
      return true;
    })
    .reverse();
  return { total: filtered.length, items: filtered.slice(offset, offset + limit), persistent: fileOk };
}

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const url = req.originalUrl.split('?')[0];
    if (url === '/api/health') return;
    const status = res.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    write(level, 'http', `${req.method} ${url} ${status}`, {
      method: req.method,
      path: url,
      status,
      ms: Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10,
      ip: req.ip,
      admin: req.admin ? req.admin.username : undefined,
    });
  });
  next();
}

module.exports = {
  info: (type, message, meta) => write('info', type, message, meta),
  warn: (type, message, meta) => write('warn', type, message, meta),
  error: (type, message, meta) => write('error', type, message, meta),
  query,
  requestLogger,
  flush,
};
