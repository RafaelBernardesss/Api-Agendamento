require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('Defina JWT_SECRET (16+ caracteres) no arquivo .env antes de iniciar.');
  process.exit(1);
}

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
  console.error('Defina ENCRYPTION_KEY (32+ caracteres) no arquivo .env antes de iniciar. Veja o .env.example.');
  process.exit(1);
}

const { errorHandler } = require('./lib/http');
const log = require('./lib/logger');
const { ensureBaseData } = require('./lib/bootstrap');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();
app.set('trust proxy', 1);

const origins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(helmet());
app.use(log.requestLogger);
app.use(cors(origins.length ? { origin: origins } : undefined));
app.use(express.json({ limit: '50kb' }));

app.use('/api/admin', adminRoutes);
app.use('/api', publicRoutes);

app.use((_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use(errorHandler);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`API Bela Donzela rodando na porta ${port}`);
  log.info('system', 'servidor_iniciado', { port });
  ensureBaseData().catch((err) => {
    console.error('Não foi possível preparar os dados iniciais:', err.message);
    log.error('system', 'dados_iniciais_falharam', { reason: err.message });
  });
  require('./lib/upgrade')
    .upgradeAppointments()
    .catch((err) => console.error('Não foi possível ajustar os agendamentos antigos. Rode "npm run setup" para atualizar o banco:', err.message));
  require('./lib/reminders').start();
});
