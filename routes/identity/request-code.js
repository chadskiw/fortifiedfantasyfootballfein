// TRUE_LOCATION: routes/identity/request-code.js
// IN_USE: TRUE
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../src/db/pool'); // adjust path if your pool lives elsewhere

const router = express.Router();
router.use(express.json());

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RX = /^\+?[0-9\s().-]{7,20}$/;

function normalizeIdentifier(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: null, value: null };
  if (EMAIL_RX.test(s)) return { kind: 'email', value: s.toLowerCase() };
  const digits = s.replace(/[^\d+]/g, '');
  if (PHONE_RX.test(s) && (digits.match(/\d/g) || []).length >= 7) {
    const e164ish = digits.startsWith('+') ? digits : `+${digits}`;
    return { kind: 'phone', value: e164ish };
  }
  return { kind: null, value: null };
}

const recent = new Map(); // naive in-memory rate limit
function ratelimit(key, limit = 6, ttlMs = 60_000) {
  const now = Date.now();
  const rec = recent.get(key);
  if (!rec || rec.resetAt <= now) {
    recent.set(key, { count: 1, resetAt: now + ttlMs });
    return { ok: true, remaining: limit - 1, resetAt: now + ttlMs };
  }
  if (rec.count >= limit) return { ok: false, remaining: 0, resetAt: rec.resetAt };
  rec.count += 1;
  return { ok: true, remaining: limit - rec.count, resetAt: rec.resetAt };
}

const CREATE_REQUESTS_SQL = `
  CREATE TABLE IF NOT EXISTS ff_identity_requests (
    id BIGSERIAL PRIMARY KEY,
    identifier_kind TEXT NOT NULL,
    identifier_value TEXT NOT NULL,
    ip_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )
`;

async function ensureRequestsTable() {
  await pool.query(CREATE_REQUESTS_SQL);
}

async function sendCode({ identifierKind, identifierValue, code }) {
  // No-op if no creds so we never 500 due to env
  if (identifierKind === 'email') {
    const haveSendgrid = !!process.env.SENDGRID_API_KEY;
    const haveSmtp = !!process.env.SMTP_HOST;
    if (!haveSendgrid && !haveSmtp) {
      console.log(`[MAIL:NOOP] to=${identifierValue} code=${code}`);
      return;
    }
    const nodemailer = require('nodemailer');
    let transporter;
    if (haveSendgrid) {
      const sgTransport = require('nodemailer-sendgrid').default;
      transporter = nodemailer.createTransport(sgTransport({ apiKey: process.env.SENDGRID_API_KEY }));
    } else {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
    }
    await transporter.sendMail({
      from: process.env.MAIL_FROM || 'Fortified Fantasy <no-reply@fortifiedfantasy.com>',
      to: identifierValue,
      subject: 'Your Fortified Fantasy sign-in code',
      text: `Your code is: ${code} (valid for 10 minutes)`,
    });
    return;
  }

  if (identifierKind === 'phone') {
    const haveTwilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
    if (!haveTwilio) {
      console.log(`[SMS:NOOP] to=${identifierValue} code=${code}`);
      return;
    }
    const twilio = require('twilio')(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    await twilio.messages.create({
      to: identifierValue,
      from: process.env.TWILIO_FROM,
      body: `Fortified Fantasy code: ${code}`,
    });
  }
}

router.post('/', async (req, res) => {
  const start = Date.now();
  try {
    const { identifier } = req.body || {};
    const { kind, value } = normalizeIdentifier(identifier);

    if (!value) {
      return res.status(422).json({
        ok: false,
        error: 'invalid_identifier',
        message: 'Provide a valid email or E.164 phone number.',
      });
    }

    const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
    const rl = ratelimit(`${ipHash}:${value}`, 6, 60_000);
    if (!rl.ok) {
      return res.status(429).json({ ok: false, error: 'rate_limited', resetAt: rl.resetAt });
    }

    await ensureRequestsTable();

    await pool.query(
      `INSERT INTO ff_identity_requests (identifier_kind, identifier_value, ip_hash) VALUES ($1,$2,$3)`,
      [kind, value, ipHash]
    );

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await sendCode({ identifierKind: kind, identifierValue: value, code });

    return res.status(200).json({ ok: true, sent: true, ms: Date.now() - start });
  } catch (err) {
    console.error('identity.request-code error:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
