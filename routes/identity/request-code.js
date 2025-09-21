// TRUE_LOCATION: routes/identity/request-code.js
// IN_USE: TRUE
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../src/db/pool');

const router = express.Router();
router.use(express.json());

/* --------------------------- identifier detection -------------------------- */
const EMAIL_RX  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RX  = /^\+?[0-9\s().-]{7,20}$/;
const HANDLE_RX = /^[a-zA-Z0-9_.]{3,24}$/;

function normalizeIdentifier(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: null, value: null };
  if (EMAIL_RX.test(s)) return { kind: 'email', value: s.toLowerCase() };
  const digits = s.replace(/[^\d+]/g, '');
  if (PHONE_RX.test(s) && (digits.match(/\d/g) || []).length >= 7) {
    const e164ish = digits.startsWith('+') ? digits : `+${digits}`;
    return { kind: 'phone', value: e164ish };
  }
  if (HANDLE_RX.test(s)) return { kind: 'handle', value: s };
  return { kind: null, value: null };
}

/* ------------------------------ tiny rate limit --------------------------- */
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

/* -------------------------- log table (single stmt) ------------------------ */
const CREATE_REQUESTS_SQL = `
  CREATE TABLE IF NOT EXISTS ff_identity_requests (
    id BIGSERIAL PRIMARY KEY,
    identifier_kind  TEXT NOT NULL,
    identifier_value TEXT NOT NULL,
    ip_hash          TEXT,
    created_at       TIMESTAMPTZ DEFAULT now()
  )
`;
async function ensureRequestsTable() {
  await pool.query(CREATE_REQUESTS_SQL);
}

/* ------------------------------- member helpers --------------------------- */
function makeInteractedCode(kind) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let base = '';
  for (let i = 0; i < 8; i++) base += alphabet[Math.floor(Math.random() * alphabet.length)];
  const suffix = (kind === 'email' || kind === 'phone' || kind === 'handle') ? kind : 'unknown';
  return `${base}-${suffix}`; // e.g. 7KX94Q2N-phone
}

async function findOrCreateMember(kind, value) {
  const col = (kind === 'email') ? 'email' : (kind === 'phone') ? 'phone_e164' : 'username';

  // Try to find existing
  const f = await pool.query(`SELECT * FROM ff_member WHERE ${col} = $1 LIMIT 1`, [value]);
  if (f.rows[0]) {
    // Backfill interacted_code if missing
    if (!f.rows[0].interacted_code) {
      const interacted = makeInteractedCode(kind);
      const upd = await pool.query(
        `UPDATE ff_member
           SET interacted_code = $1,
               last_seen_at     = now()
         WHERE member_id = $2
         RETURNING *`,
        [interacted, f.rows[0].member_id]
      );
      return upd.rows[0];
    }
    return f.rows[0];
  }

  // Create minimal new member with interacted_code (NOT NULL)
  const interacted = makeInteractedCode(kind);
  const ins = await pool.query(
    `INSERT INTO ff_member (${col}, interacted_code, first_seen_at, last_seen_at)
     VALUES ($1, $2, now(), now())
     RETURNING *`,
    [value, interacted]
  );
  return ins.rows[0];
}

function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* --------------------------- Notification sender --------------------------- */
// Prefer NotificationAPI; fallback to email/SMS providers. Never throw on send.
let notifInited = false;
let notifReady = false;
let notificationapi = null;
function initNotificationAPI() {
  if (notifInited) return notifReady;
  notifInited = true;
  try {
    const clientId = process.env.NOTIFICATIONAPI_CLIENT_ID;
    const clientSecret = process.env.NOTIFICATIONAPI_CLIENT_SECRET;
    if (clientId && clientSecret) {
      notificationapi = require('notificationapi-node-server-sdk').default;
      notificationapi.init(clientId, clientSecret);
      notifReady = true;
      console.log('[notify] SDK initialized');
    } else {
      console.log('[notify] SDK not available; missing env credentials');
    }
  } catch (e) {
    console.log('[notify] SDK not initialized:', e?.message || e);
    notifReady = false;
  }
  return notifReady;
}

async function sendViaNotificationAPI({ identifierKind, identifierValue, code }) {
  try {
    const ok = initNotificationAPI();
    if (!ok) return false;

    const user = { id: identifierValue };
    if (identifierKind === 'email') user.email = identifierValue;
    if (identifierKind === 'phone') user.phone = identifierValue;

    await notificationapi.send({
      notificationId: process.env.NOTIFICATIONAPI_TEMPLATE_ID || 'login-code',
      user,
      mergeTags: { code }
    });
    return true;
  } catch (e) {
    console.warn('[notify] send failed:', e?.message || e);
    return false;
  }
}

async function sendViaFallbackProviders({ identifierKind, identifierValue, code }) {
  try {
    if (identifierKind === 'email') {
      const haveSendgrid = !!process.env.SENDGRID_API_KEY;
      const haveSmtp     = !!process.env.SMTP_HOST;
      if (!haveSendgrid && !haveSmtp) {
        console.log(`[MAIL:NOOP] to=${identifierValue} code=${code}`);
        return true;
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
      return true;
    }

    if (identifierKind === 'phone') {
      const haveTwilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
      if (!haveTwilio) {
        console.log(`[SMS:NOOP] to=${identifierValue} code=${code}`);
        return true;
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
      return true;
    }
  } catch (e) {
    console.warn('[fallback send] failed:', e?.message || e);
  }
  return false;
}

async function sendCode({ identifierKind, identifierValue, code }) {
  // Try NotificationAPI first, then fallback. Never throw.
  const viaNotif = await sendViaNotificationAPI({ identifierKind, identifierValue, code });
  if (viaNotif) return;
  await sendViaFallbackProviders({ identifierKind, identifierValue, code });
}

/* --------------------------------- route ---------------------------------- */
// POST /api/identity/request-code
router.post('/', async (req, res) => {
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
    if (!rl.ok) return res.status(429).json({ ok: false, error: 'rate_limited', resetAt: rl.resetAt });

    await ensureRequestsTable();
    await pool.query(
      `INSERT INTO ff_identity_requests (identifier_kind, identifier_value, ip_hash) VALUES ($1,$2,$3)`,
      [kind, value, ipHash]
    );

    // Ensure we have a member and an interacted_code
    const member = await findOrCreateMember(kind, value);

    // Generate login code + expiry
    const code = makeCode();
    const exp  = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // IMPORTANT: also ensure interacted_code is set for older rows (COALESCE)
    const interacted = member.interacted_code || makeInteractedCode(kind);
    await pool.query(
      `UPDATE ff_member
          SET interacted_code     = COALESCE(interacted_code, $1),
              login_code          = $2,
              login_code_expires  = $3,
              last_seen_at        = now()
        WHERE member_id = $4`,
      [interacted, code, exp, member.member_id]
    );

    // Set handoff cookie like signup flow expects
    res.cookie('ff_interacted', interacted, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 365 // 1 year
    });

    // Try to send (never blocks continuation)
    try { await sendCode({ identifierKind: kind, identifierValue: value, code }); } catch {}

    // Always return signup_url so the client navigates (your page checks this) :contentReference[oaicite:1]{index=1}
    const u = new URL('/signup', 'https://fortifiedfantasy.com');
    if (kind === 'email')  u.searchParams.set('email', value);
    if (kind === 'phone')  u.searchParams.set('phone', value);
    if (kind === 'handle') u.searchParams.set('handle', value);

    return res.status(200).json({
      ok: true,
      sent: true,
      member_id: member.member_id,
      interacted_code: interacted,
      signup_url: u.pathname + u.search,
      ms: Date.now() - start
    });
  } catch (err) {
    console.error('identity.request-code error:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
