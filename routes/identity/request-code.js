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
const path = require('path');
let WORDS;
try {
  WORDS = require('../../data/recovery_words.json');
} catch (_e) {
  WORDS = { adjectives: [], nouns: [] };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makeRecoveryTripleOnce() {
  const adjs = WORDS.adjectives?.length ? WORDS.adjectives : ['mighty','fearless','electric','legendary'];
  const nouns = WORDS.nouns?.length ? WORDS.nouns : ['endzone','touchdown','huddle','gridiron'];

  let a1 = pick(adjs), a2 = pick(adjs);
  // ensure different adjectives
  for (let i = 0; i < 5 && a2 === a1; i++) a2 = pick(adjs);

  const n1 = pick(nouns);
  return { adj1: a1, adj2: a2, noun: n1 };
}

/**
 * Generate a unique (adj1, adj2, noun) triple under the orderless constraint.
 * - Checks existence using LEAST/GREATEST on adjectives
 * - Retries up to 20 times (extremely unlikely to exhaust with decent lists)
 */
async function makeUniqueRecoveryTriple() {
  for (let i = 0; i < 20; i++) {
    const { adj1, adj2, noun } = makeRecoveryTripleOnce();
    const { rows } = await pool.query(
      `SELECT 1
         FROM ff_member
        WHERE LEAST(adj1, adj2) = LEAST($1, $2)
          AND GREATEST(adj1, adj2) = GREATEST($1, $2)
          AND noun = $3
        LIMIT 1`,
      [adj1, adj2, noun]
    );
    if (!rows[0]) return { adj1, adj2, noun };
  }
  // As a last resort, just return the last attempt; INSERT will 409 and we’ll retry there.
  return makeRecoveryTripleOnce();
}

/* ------------------------------- member helpers --------------------------- */
function makeInteractedCode(kind, value) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let base = '';
  for (let i = 0; i < 8; i++) base += alphabet[Math.floor(Math.random() * alphabet.length)];
  const label = kind === 'email' ? 'EMAIL' : kind === 'phone' ? 'PHONE' : kind === 'handle' ? 'HANDLE' : 'UNKNOWN';
  return `${base}-${label}:${value}`;   // e.g. 7KX94Q2N-PHONE:+17175218287
}


async function findOrCreateMember(kind, value) {
  const col = (kind === 'email') ? 'email' : (kind === 'phone') ? 'phone_e164' : 'username';

  // Try to find existing
  const f = await pool.query(`SELECT * FROM ff_member WHERE ${col} = $1 LIMIT 1`, [value]);
  if (f.rows[0]) {
    const row = f.rows[0];

    // Backfill recovery triple if missing any part
    if (!row.adj1 || !row.adj2 || !row.noun) {
      const triple = await generateUniqueMemberId();
      const upd = await pool.query(
        `UPDATE ff_member
            SET adj1 = $1,
                adj2 = $2,
                noun = $3,
                last_seen_at = now()
          WHERE member_id = $4
          RETURNING *`,
        [triple.adj1, triple.adj2, triple.noun, row.member_id || null]
      );
      return upd.rows[0];
    }
    return row;
  }

  // Create new member with a unique triple
  const triple = await makeUniqueRecoveryTriple();
  // Note: interacted_code becomes optional; we can derive a legacy string if you still want the cookie
  const legacy = `${triple.adj1}-${triple.adj2}-${triple.noun}`;

  // Robust insert with retry on unique violation (extremely rare)
  for (let tries = 0; tries < 5; tries++) {
    try {
      const ins = await pool.query(
        `INSERT INTO ff_member (${col}, interacted_code, adj1, adj2, noun, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())
         RETURNING *`,
        [value, legacy, triple.adj1, triple.adj2, triple.noun]
      );
      return ins.rows[0];
    } catch (e) {
      // 23505 = unique_violation on the index; generate another triple and retry
      if (e && e.code === '23505') {
        const t2 = await makeUniqueRecoveryTriple();
        triple.adj1 = t2.adj1; triple.adj2 = t2.adj2; triple.noun = t2.noun;
        continue;
      }
      throw e;
    }
  }
  // Should never reach here
  throw new Error('could_not_insert_member_unique_triple');
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
await pool.query(
  `UPDATE ff_member
      SET login_code         = $1,
          login_code_expires = $2,
          last_seen_at       = now()
    WHERE member_id = $3`,
  [code, exp, member.member_id || null]
);



    // Set handoff cookie like signup flow expects
    res.cookie('ff_interacted', member.interacted_code,
 {
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
      member_id: member.member_id || null,
      interacted_code: interacted,
      signup_url: u.pathname + u.search,
      ms: Date.now() - start
    });
  } catch (err) {
    console.error('identity.request-code error:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});
async function generateUniqueMemberId(pool) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
  function makeId() {
    let out = '';
    for (let i = 0; i < 8; i++) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  }

  while (true) {
    const candidate = makeId();
    const check = await pool.query(
      'SELECT 1 FROM ff_member WHERE member_id = $1 LIMIT 1',
      [candidate]
    );
    if (check.rowCount === 0) return candidate; // unique
  }
}

module.exports = router;
