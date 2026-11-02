require('dotenv').config();
const raw = require('../src/rawdb');
const { FIELDS } = require('../src/lib/pii');
const { encryptDet, encryptRandom, isEncrypted } = require('../src/lib/crypto');

const DELEGATE = { Appointment: 'appointment', User: 'user', Notification: 'notification', PushToken: 'pushToken', Admin: 'admin' };

(async () => {
  let total = 0;
  for (const [model, fields] of Object.entries(FIELDS)) {
    const rows = await raw[DELEGATE[model]].findMany();
    let changed = 0;
    for (const row of rows) {
      const data = {};
      for (const [f, kind] of Object.entries(fields)) {
        const v = row[f];
        if (typeof v === 'string' && v !== '' && !isEncrypted(v)) data[f] = kind === 'det' ? encryptDet(v) : encryptRandom(v);
      }
      if (Object.keys(data).length) {
        await raw[DELEGATE[model]].update({ where: { id: row.id }, data });
        changed++;
      }
    }
    console.log(`${model}: ${changed} de ${rows.length} registros criptografados`);
    total += changed;
  }
  console.log(total ? 'Pronto.' : 'Nada a fazer: tudo já estava criptografado.');
})()
  .catch((e) => { console.error(e.message); process.exit(1); })
  .finally(() => raw.$disconnect());
