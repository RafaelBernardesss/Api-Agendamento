const crypto = require('node:crypto');

const PREFIX = 'enc1:';
let keys = null;

function loadKeys() {
  if (keys) return keys;
  const secret = process.env.ENCRYPTION_KEY || '';
  if (secret.length < 32) {
    throw new Error(
      'ENCRYPTION_KEY ausente ou curta (mínimo 32 caracteres) no .env. Gere uma com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  const root = Buffer.from(secret, 'utf8');
  const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', root, Buffer.alloc(0), info, 32));
  keys = { enc: derive('bela-donzela/enc'), mac: derive('bela-donzela/siv') };
  return keys;
}

const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

function seal(plain, iv) {
  const { enc } = loadKeys();
  const cipher = crypto.createCipheriv('aes-256-gcm', enc, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

function encryptRandom(plain) {
  if (plain === null || plain === undefined) return plain;
  return seal(String(plain), crypto.randomBytes(12));
}

function encryptDet(plain) {
  if (plain === null || plain === undefined) return plain;
  const text = String(plain);
  const iv = crypto.createHmac('sha256', loadKeys().mac).update(text).digest().subarray(0, 12);
  return seal(text, iv);
}

function decrypt(value) {
  if (!isEncrypted(value)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKeys().enc, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

module.exports = { encryptRandom, encryptDet, decrypt, isEncrypted, PREFIX };
