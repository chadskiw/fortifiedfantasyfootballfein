// src/routes/identity/request-code.js
// POST /api/identity/request-code   (+ alias /send-code)

const express = require('express');
const crypto  = require('crypto');

// IMPORTANT: get the *instance* via destructuring
const { pool } = require('../../db/pool');

if (!pool || typeof pool.query !== 'function') {
  throw new Error('[request-code] pg pool missing or invalid');
}

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

/* ------------------------ helpers ------------------------ */

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE  = /^\+?[0-9\-\s().]{7,}$/;
const HANDLE_RE = /^[a-zA-Z0-9_.](?:[a-zA-Z0-9_. ]{1,22})[a-zA-Z0-9_.]$/; // allow single spaces inside, no ends
const HEX_RE    = /^#?[0-9a-f]{6}$/i;

const nowIso = () => new Date().toISOString();

function normalizeIdentifier(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: null, value: null };

  if (EMAIL_RE.test(s)) {
    return { kind: 'email', value: s.toLowerCase() };
  }
  if (PHONE_RE.test(s)) {
    const digits = s.replace(/[^\d]/g, '');
    const e164 = digits.startsWith('1') && digits.length === 11 ? `+${digits}` :
                 digits.length === 10 ? `+1${digits}` :
                 `+${digits}`;
    return { kind: 'phone', value: e164 };
  }
  if (HANDLE_RE.test(s)) {
    const handle = s.replace(/\s{2,}/g, ' ');
    return { kind: 'handle', value: handle };
  }
  return { kind: null, value: null };
}

function isValidHex(h) {
  return HEX_RE.test(String(h || '').replace('#',''));
}
function normalizeHex(h) {
  if (!h) return null;
  const v = String(h).trim();
  if (!isValidHex(v)) return null;
  const hh = v.startsWith('#') ? v.toUpperCase() : ('#' + v.toUpperCase());
  return hh;
}

function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ultra-simple, in-process rate limiter (keyed by ipHash:identifier)
const RL_BUCKET = new Map(); // key -> {cnt, ts}
function ratelimit(key, maxCount, windowMs) {
  const now = Date.now();
  const rec = RL_BUCKET.get(key);
  if (!rec || (now - rec.ts) > windowMs) {
    RL_BUCKET.set(key, { cnt: 1, ts: now });
    return { ok: true, remaining: maxCount - 1 };
  }
  if (rec.cnt >= maxCount) return { ok: false, remaining: 0 };
  rec.cnt++;
  return { ok: true, remaining: maxCount - rec.cnt };
}

async function ensureRequestsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_identity_requests (
      id                BIGSERIAL PRIMARY KEY,
      identifier_kind   TEXT NOT NULL,
      identifier_value  TEXT NOT NULL,
      ip_hash           TEXT,
      token             TEXT,
      phrase_hash       TEXT,
      sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at           TIMESTAMPTZ,
      expires_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS ff_identity_requests_value_idx
      ON ff_identity_requests (identifier_value);
    CREATE INDEX IF NOT EXISTS ff_identity_requests_token_idx
      ON ff_identity_requests (token);
  `);
}

function newMemberId() {
  return crypto.randomBytes(6).toString('base64url')
    .replace(/[^0-9A-Za-z]/g,'').slice(0, 8).toUpperCase();
}

async function findMemberBy(kind, value) {
  const where =
    kind === 'email'  ? 'LOWER(email) = LOWER($1)' :
    kind === 'phone'  ? 'phone_e164 = $1' :
    kind === 'handle' ? 'LOWER(username) = LOWER($1)' : '1=0';
  const { rows } = await pool.query(`
    SELECT member_id, username, email, phone_e164, color_hex,
           email_verified_at, phone_verified_at
      FROM ff_member
     WHERE ${where} AND deleted_at IS NULL
     ORDER BY member_id ASC
     LIMIT 1
  `, [value]);
  return rows[0] || null;
}

async function createEmptyMemberSkeleton() {
  for (let i=0;i<5;i++) {
    const mid = newMemberId();
    try {
      await pool.query(`
        INSERT INTO ff_member (member_id, first_seen_at, last_seen_at, event_count)
        VALUES ($1, NOW(), NOW(), 0)
      `, [mid]);
      return mid;
    } catch (e) {
      if (e.code === '23505') continue;
      throw e;
    }
  }
  throw new Error('member_id_alloc_failed');
}

async function findOrCreateMember(kind, value) {
  const existing = await findMemberBy(kind, value);
  if (existing) return existing;

  const qhWhere =
    kind === 'email'  ? 'LOWER(email) = LOWER($1)' :
    kind === 'phone'  ? 'phone = $1' :
    kind === 'handle' ? 'LOWER(handle) = LOWER($1)' : '1=0';
  const qh = await pool.query(`
    SELECT member_id, handle, color_hex, phone, email
      FROM ff_quickhitter
     WHERE ${qhWhere}
     LIMIT 1
  `, [value]);
  if (qh.rows[0]?.member_id) {
    const { member_id, handle, color_hex, phone, email } = qh.rows[0];
    const m = await pool.query(`SELECT member_id FROM ff_member WHERE member_id=$1`, [member_id]);
    if (!m.rows[0]) {
      await pool.query(`
        INSERT INTO ff_member (
          member_id, username, email, phone_e164, color_hex,
          first_seen_at, last_seen_at, event_count
        ) VALUES ($1,$2,$3,$4,$5, NOW(), NOW(), 0)
      `, [
        member_id,
        handle || null,
        email || null,
        phone || null,
        color_hex ? (color_hex.startsWith('#') ? color_hex.toUpperCase() : ('#' + color_hex.toUpperCase())) : null
      ]);
    }
    const back = await pool.query(`
      SELECT member_id, username, email, phone_e164, color_hex,
             email_verified_at, phone_verified_at
        FROM ff_member WHERE member_id=$1
    `, [member_id]);
    return back.rows[0];
  }

  const member_id = await createEmptyMemberSkeleton();

  if (kind === 'email' || kind === 'phone') {
    const col = kind === 'email' ? 'email' : 'phone_e164';
    await pool.query(`
      UPDATE ff_member
         SET ${col} = $1,
             last_seen_at = NOW()
       WHERE member_id = $2
    `, [value, member_id]);
  }

  return (await pool.query(`
    SELECT member_id, username, email, phone_e164, color_hex,
           email_verified_at, phone_verified_at
      FROM ff_member
     WHERE member_id = $1
  `, [member_id])).rows[0];
}

// Plug your real Notification API here
async function sendCode({ identifierKind, identifierValue, code }) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[request-code] would send', { to: identifierValue, kind: identifierKind, code });
    return;
  }
  try {
    console.log('[request-code] sent (stub)', { to: identifierValue, kind: identifierKind });
  } catch (e) {
    console.error('[request-code] send failed (non-fatal):', e.message);
  }
}

/* ------------------------ route ------------------------ */

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

    const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
    const rl = ratelimit(`${ipHash}:${value}`, 6, 60_000);
    if (!rl.ok) return res.status(429).json({ ok: false, error: 'rate_limited' });

    await ensureRequestsTable();
    await pool.query(
      `INSERT INTO ff_identity_requests (identifier_kind, identifier_value, ip_hash)
       VALUES ($1,$2,$3)`,
      [kind, value, ipHash]
    );

    const member = await findOrCreateMember(kind, value);
    if (!member || !member.member_id) throw new Error('member_creation_failed');

    const incomingHandle = (req.body?.handle || '').trim() || null;
    const incomingHex    = normalizeHex(req.body?.hex || null);

    let nextUsername = member.username || null;
    let nextHex      = member.color_hex || null;

    if (incomingHandle && HANDLE_RE.test(incomingHandle)) {
      nextUsername = incomingHandle.replace(/\s{2,}/g,' ');
    }
    if (incomingHex) nextHex = incomingHex;

    if (nextUsername && !nextHex) {
      const palette = ['#1F77B4','#2CA02C','#D62728','#7F7F7F','#BCBD22','#17BECF','#FF7F0E','#008744','#D62D20','#FFA700','#4C4C4C','#0057E7'];
      nextHex = palette[Math.floor(Math.random() * palette.length)];
    }

    if (nextUsername || nextHex) {
      await pool.query(
        `UPDATE ff_member
           SET username     = COALESCE($1, username),
               color_hex    = COALESCE($2, color_hex),
               last_seen_at = NOW()
         WHERE member_id = $3`,
        [nextUsername, nextHex, member.member_id]
      );
    }

    const code = makeCode();
    const exp  = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await pool.query(
      `UPDATE ff_member
          SET login_code         = $1,
              login_code_expires = $2,
              last_seen_at       = NOW()
        WHERE member_id = $3`,
      [code, exp, member.member_id]
    );

    sendCode({ identifierKind: kind, identifierValue: value, code }).catch(() => {});

    const secure = process.env.NODE_ENV === 'production';
    res.cookie('ff_member', member.member_id, {
      httpOnly: true,
      sameSite: 'Lax',
      secure,
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });

    const proto = (req.headers['x-forwarded-proto'] || (secure ? 'https' : 'http'));
    const host  = req.headers['x-forwarded-host'] || req.headers.host || 'fortifiedfantasy.com';
    const u = new URL('/signup', `${proto}://${host}`);
    if (kind === 'email')  u.searchParams.set('email', value);
    if (kind === 'phone')  u.searchParams.set('phone', value);
    if (kind === 'handle') u.searchParams.set('handle', value);

    return res.status(200).json({
      ok: true,
      sent: true,
      member_id: member.member_id,
      signup_url: u.pathname + u.search,
      ms: Date.now() - start
    });

  } catch (err) {
    console.error('identity.request-code error:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.post('/send-code', (req, res, next) => {
  req.url = '/request-code';
  next();
});

module.exports = router;
