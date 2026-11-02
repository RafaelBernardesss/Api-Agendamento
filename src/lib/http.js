const log = require('./logger');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err && err.name === 'ZodError') {
    const first = err.issues && err.issues[0];
    return res.status(400).json({ error: first ? first.message : 'Dados inválidos.' });
  }
  if (err && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: 'Requisição inválida.' });
  }
  console.error(err);
  log.error('error', err && err.message ? err.message : 'erro desconhecido', {
    path: String(_req.originalUrl || '').split('?')[0],
    method: _req.method,
    stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : undefined,
  });
  return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
}

module.exports = { HttpError, wrap, errorHandler };
