// Outgoing email (weekly reports, address verification). Configure with SMTP_URL, e.g.
//   smtps://USER:PASSWORD@smtp-relay.brevo.com:465   or   smtp://USER:APP_PASSWORD@smtp.gmail.com:587
// and MAIL_FROM ("Synapse <reports@yourdomain>"). Unset = email features are switched off.
// SMTP_URL=json is a test mode that keeps messages in memory instead of sending.
const nodemailer = require('nodemailer');

const url = (process.env.SMTP_URL || '').trim();
const from = (process.env.MAIL_FROM || '').trim() || 'Synapse <no-reply@synapse.local>';
const enabled = !!url;
const outbox = [];
let transport = null;
if (url === 'json') transport = nodemailer.createTransport({ jsonTransport: true });
else if (url) transport = nodemailer.createTransport(url);

async function send({ to, subject, html, text, headers }) {
  if (!transport) throw Object.assign(new Error('Email is not set up on this server.'), { status: 503, expose: true });
  const info = await transport.sendMail({ from, to, subject, html, text, headers });
  if (url === 'json') outbox.push({ to, subject, html, text, headers });
  return info;
}

module.exports = { enabled, send, outbox, from };
