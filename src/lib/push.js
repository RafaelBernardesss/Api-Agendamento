const prisma = require('../db');

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK = 100;

async function sendPush(owners, { title, body, data = {} }) {
  try {
    const list = [...new Set(owners)];
    if (!list.length) return;
    const rows = await prisma.pushToken.findMany({ where: { owner: { in: list } } });
    if (!rows.length) return;

    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const messages = chunk.map((r) => ({
        to: r.token,
        title,
        body,
        data,
        sound: 'default',
        channelId: 'default',
        priority: 'high',
      }));
      const res = await fetch(EXPO_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(10000),
      });
      const json = await res.json().catch(() => null);
      const tickets = json && Array.isArray(json.data) ? json.data : [];
      const dead = [];
      tickets.forEach((t, idx) => {
        if (t && t.status === 'error' && t.details && t.details.error === 'DeviceNotRegistered' && chunk[idx]) {
          dead.push(chunk[idx].token);
        }
      });
      if (dead.length) await prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
    }
  } catch (err) {
    console.error('Falha ao enviar push:', err.message);
  }
}

module.exports = { sendPush };
