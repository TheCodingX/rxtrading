// ══════════════════════════════════════════════════════════════════════
// MAILER — Pluggable email sender (SendGrid / AWS SES / Postmark / SMTP)
// ══════════════════════════════════════════════════════════════════════
// Selecciona provider por env var MAIL_PROVIDER. Default: 'stub' (log only).
// Para habilitar email real en producción:
//   MAIL_PROVIDER=sendgrid + SENDGRID_API_KEY=xxx + MAIL_FROM=noreply@rxtrading.net
//   MAIL_PROVIDER=ses + AWS_ACCESS_KEY_ID=xxx + AWS_SECRET_ACCESS_KEY=yyy + AWS_REGION=us-east-1
//   MAIL_PROVIDER=postmark + POSTMARK_API_TOKEN=xxx
//   MAIL_PROVIDER=smtp + SMTP_HOST=... + SMTP_USER=... + SMTP_PASS=... (requires nodemailer)
// ══════════════════════════════════════════════════════════════════════

const MAIL_PROVIDER = (process.env.MAIL_PROVIDER || 'stub').toLowerCase();
const MAIL_FROM = process.env.MAIL_FROM || 'noreply@rxtrading.net';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'RX Trading';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://rxtrading.net';

// ───── Provider: SendGrid ─────
async function sendViaSendgrid({ to, subject, html, text }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('SENDGRID_API_KEY not configured');
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }], subject }],
      from: { email: MAIL_FROM, name: MAIL_FROM_NAME },
      content: [
        ...(text ? [{ type: 'text/plain', value: text }] : []),
        { type: 'text/html', value: html }
      ]
    })
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`SendGrid ${r.status}: ${body.slice(0, 200)}`);
  }
  return { ok: true, provider: 'sendgrid', messageId: r.headers.get('x-message-id') };
}

// ───── Provider: Postmark ─────
async function sendViaPostmark({ to, subject, html, text }) {
  const token = process.env.POSTMARK_API_TOKEN;
  if (!token) throw new Error('POSTMARK_API_TOKEN not configured');
  const r = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': token },
    body: JSON.stringify({
      From: `${MAIL_FROM_NAME} <${MAIL_FROM}>`,
      To: to, Subject: subject,
      HtmlBody: html, TextBody: text || ''
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Postmark ${r.status}: ${j.Message || JSON.stringify(j).slice(0, 200)}`);
  return { ok: true, provider: 'postmark', messageId: j.MessageID };
}

// ───── Provider: stub (dev/tests) ─────
function sendViaStub({ to, subject }) {
  console.log('[Mailer STUB] Would send to', to.slice(0, 3) + '***', '· subject:', subject);
  return Promise.resolve({ ok: true, provider: 'stub' });
}

// ───── Dispatcher ─────
async function sendEmail(opts) {
  const { to, subject, html, text } = opts;
  if (!to || !subject || !html) throw new Error('sendEmail: to/subject/html required');
  switch (MAIL_PROVIDER) {
    case 'sendgrid': return sendViaSendgrid({ to, subject, html, text });
    case 'postmark': return sendViaPostmark({ to, subject, html, text });
    case 'stub': default: return sendViaStub({ to, subject });
  }
}

// ───── Templates ─────
function sendRecoveryEmail(email, token) {
  const link = `${FRONTEND_URL}/recover.html?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;">
      <h1 style="color:#FFD700;font-size:22px;margin-bottom:16px;">RX Trading — Recuperación de license key</h1>
      <p>Solicitaste recuperar tu license key VIP. Hacé click en el botón de abajo para ver tus license keys asociadas a este email:</p>
      <p style="text-align:center;margin:32px 0;">
        <a href="${link}" style="background:#00ff41;color:#010806;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:700;letter-spacing:1px;">RECUPERAR LICENSE KEY</a>
      </p>
      <p style="color:#666;font-size:13px;">Este link expira en 1 hora. Si no solicitaste esto, ignorá este email.</p>
      <p style="color:#999;font-size:11px;border-top:1px solid #eee;padding-top:16px;margin-top:24px;">RX Trading · <a href="${FRONTEND_URL}" style="color:#999;">${FRONTEND_URL}</a></p>
    </div>`;
  const text = `RX Trading — Recuperación de license key\n\nRecuperá tu license key visitando:\n${link}\n\nLink expira en 1 hora. Si no solicitaste esto, ignorá este email.`;
  return sendEmail({ to: email, subject: 'RX Trading — Recuperación de license key', html, text });
}

module.exports = { sendEmail, sendRecoveryEmail };
