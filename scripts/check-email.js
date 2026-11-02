require('dotenv').config();
const nodemailer = require('nodemailer');

const { SMTP_HOST, SMTP_USER, SMTP_PASS, ADMIN_EMAIL } = process.env;
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  console.log('SMTP não configurado no .env (SMTP_HOST, SMTP_USER, SMTP_PASS).');
  console.log('Sem isso, em desenvolvimento o código do admin aparece no terminal do servidor.');
  process.exit(0);
}

const port = Number(process.env.SMTP_PORT) || 587;
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port,
  secure: port === 465,
  auth: { user: SMTP_USER.trim(), pass: SMTP_PASS.replace(/\s+/g, '') },
  connectionTimeout: 8000,
});

(async () => {
  try {
    await transporter.verify();
    console.log('OK  login no servidor de e-mail funcionou.');
    if (ADMIN_EMAIL) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || SMTP_USER,
        to: ADMIN_EMAIL,
        subject: 'Teste - Ateliê Bela Donzela',
        text: 'Se você recebeu este e-mail, o envio do código de acesso está funcionando.',
      });
      console.log(`OK  e-mail de teste enviado para ${ADMIN_EMAIL} (veja também o spam).`);
    }
  } catch (e) {
    console.error('FALHOU:', e.message);
    if (/Invalid login|Username and Password|535/.test(e.message)) {
      console.error('Dica (Gmail): use uma "senha de app" (precisa da verificação em duas etapas), não a senha normal da conta.');
    }
    process.exit(1);
  }
})();
