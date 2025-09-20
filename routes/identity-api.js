// TRUE_LOCATION: routes/identity-api.js
// IN_USE: TRUE
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('../src/db/pool');

const router = express.Router();
router.use(express.json());

/* ------------------------------- /health ---------------------------------- */
router.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    const cookie = req.headers.cookie || '';
    const swidSeen = !!(req.get('x-espn-swid') || cookie.includes('SWID='));
    const s2Seen   = !!(req.get('x-espn-s2')   || cookie.includes('espn_s2=') || cookie.includes('ESPN_S2='));
    res.json({ ok: true, db: r.rows[0]?.ok === 1, credsSeen: { swid: swidSeen, s2: s2Seen } });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'db_error', message: e.message, code: e.code });
  }
});

/* ------------------------ identifier normalization ------------------------ */
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
  const handleOk = /^[a-zA-Z0-9_.]{3,24}$/.test(s);
  if (handleOk) return { kind: 'handle', value: s };
  return { kind: null, value: null };
}

/* ------------------------------ rate limiter ------------------------------ */
const recent = new Map(); // key -> { count, resetAt }
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

/* ------------------------------ db bootstrap ------------------------------ */
const CREATE_REQ_SQL = `
  CREATE TABLE IF NOT EXISTS ff_identity_requests (
    id BIGSERIAL PRIMARY KEY,
    identifier_kind  TEXT NOT NULL,
    identifier_value TEXT NOT NULL,
    ip_hash          TEXT,
    created_at       TIMESTAMPTZ DEFAULT now()
  )
`;
async function ensureRequestsTable() {
  await pool.query(CREATE_REQ_SQL);
}

/* ----------------------------- member helpers ----------------------------- */
async function findOrCreateMemberByIdentifier(kind, value) {
  // 1) try find
  let where, val;
  if (kind === 'email') { where = 'email = $1'; val = value; }
  else if (kind === 'phone') { where = 'phone_e164 = $1'; val = value; }
  else { where = 'username = $1'; val = value; }

  const f = await pool.query(`select * from ff_member where ${where} limit 1`, [val]);
  if (f.rows[0]) return f.rows[0];

  // 2) insert minimal row
  const cols = ['first_seen_at','last_seen_at'];
  const vals = ['now()','now()'];
  let colSet = '', params = [], place = [];
  if (kind === 'email') { cols.push('email'); params.push(value); }
  else if (kind === 'phone') { cols.push('phone_e164'); params.push(value); }
  else { cols.push('username'); params.push(value); }
  for (let i = 0; i < params.length; i++) place.push(`$${i+1}`);

  const ins = await pool.query(
    `insert into ff_member (${cols.join(',')})
     values (${params.length ? place.join(',') + ',' : ''}${vals.join(',')})
     returning *`,
    params
  );
  return ins.rows[0];
}

function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* ------------------------------- code sender ------------------------------ */
async function sendCode({ identifierKind, identifierValue, code }) {
  // No-op if no creds so we never 500
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

/* -------------------------------- endpoints -------------------------------- */
// POST /api/identity/request-code
router.post('/request-code', async (req, res) => {
  const start = Date.now();
  try {
    const { identifier } = req.body || {};
    const { kind, value } = normalizeIdentifier(identifier);

    if (!value) {
      return res.status(422).json({
        ok: false,
        error: 'invalid_identifier',
        message: 'Provide a valid email, E.164 phone, or handle.',
      });
    }

    // Rate-limit per (ip+identifier)
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

    // Find or create member
    const member = await findOrCreateMemberByIdentifier(kind, value);

    // Store login code (10 min TTL)
    const code = makeCode();
    const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await pool.query(
      `update ff_member
         set login_code = $1,
             login_code_expires = $2,
             last_seen_at = now()
       where member_id = $3`,
      [code, exp, member.member_id]
    );

    // Send (may be NOOP without creds)
    await sendCode({ identifierKind: kind, identifierValue: value, code });

    // Tell the client where to go next so it navigates
    const u = new URL('/signup', 'https://fortifiedfantasy.com'); // or use relative '/signup'
    u.searchParams.set(kind === 'email' ? 'email' : kind === 'phone' ? 'phone' : 'handle', value);

    return res.status(200).json({
      ok: true,
      sent: true,
      member_id: member.member_id,
      signup_url: u.pathname + u.search, // client will redirect
      ms: Date.now() - start
    });
  } catch (err) {
    console.error('identity.request-code error:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
