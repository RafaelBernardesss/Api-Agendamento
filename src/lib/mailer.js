const nodemailer = require('nodemailer');

let transporter = null;

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

function codeEmailHtml(code) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto;padding:28px;border:1px solid #F6D3E0;border-radius:18px;background:#FFFFFF;color:#2B1B24">
    <h2 style="margin:0 0 6px;color:#B83A78;font-weight:600">Ateliê Bela Donzela</h2>
    <p style="margin:0 0 18px;color:#9A7B88;font-size:14px">Código de acesso à Área Administrativa</p>
    <div style="font-size:34px;letter-spacing:10px;font-weight:700;text-align:center;padding:16px 0;background:#FDE4EE;border-radius:14px;color:#B83A78">${code}</div>
    <p style="margin:18px 0 0;font-size:13px;color:#9A7B88">Ele vale por 10 minutos. Se não foi você que pediu, ignore este e-mail.</p>
  </div>`;
}

async function sendAdminCode(to, code) {
  if (!smtpConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP não configurado (SMTP_HOST, SMTP_USER, SMTP_PASS).');
    }
    console.log(`\n[DEV] SMTP não configurado. Código do admin para ${to}: ${code}\n`);
    return;
  }
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || `Ateliê Bela Donzela <${process.env.SMTP_USER}>`,
    to,
    subject: `${code} é o seu código de acesso`,
    text: `Seu código de acesso à Área Administrativa do Ateliê Bela Donzela é ${code}. Ele vale por 10 minutos.`,
    html: codeEmailHtml(code),
  });
}

module.exports = { sendAdminCode, smtpConfigured };
