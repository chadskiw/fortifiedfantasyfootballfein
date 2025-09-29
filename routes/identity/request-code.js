// routes/identity/request-code.js
const express = require('express');
const crypto  = require('crypto');

let db = require('../../src/db/pool');
let pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[identity/request-code] pg pool missing/invalid import');
}

const { sendOne } = require('../../services/notify');

const router = express.Router();
router.use(express.json({ limit: '2mb' }));
router.use(express.urlencoded({ extended: false }));

/* ---------------- helpers ---------------- */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE  = /^\+[1-9]\d{7,14}$/;

function toE164(raw){
  if (!raw) return null;
  const d = String(raw).replace(/\D+/g,'');
  if (!d) return null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length >= 7 && d.length <= 15) return `+${d}`;
  return null;
}

function normalizeIdentifier(input){
  const raw = String(input || '').trim();
  if (!raw) return { kind:null, value:null, channel:null, error:'empty' };
  if (EMAIL_RE.test(raw)) {
    return { kind:'email', value: raw.toLowerCase(), channel:'email' };
  }
  const p = toE164(raw);
  if (p && E164_RE.test(p)) return { kind:'phone', value:p, channel:'sms' };
  return { kind:null, value:null, channel:null, error:'invalid_identifier' };
}

function sixDigit(){
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function mask(kind, value){
  if (kind === 'email') {
    try {
      const [u,h] = value.split('@');
      const uu = u.length <= 2 ? u : (u[0] + '***' + u.slice(-1));
      const hh = h.replace(/^(.)(.*)(\..*)$/, (_,a,_b,c)=> a + '***' + c);
      return `${uu}@${hh}`;
    } catch { return value; }
  }
  if (kind === 'phone') return value.replace(/^(\+\d{0,2})\d+(?=\d{2}$)/, (_,cc)=> cc + '***');
  return value;
}

/* ---------------- tiny rate limit ---------------- */
const RL = new Map();
function rateLimit(key, limit=6, windowMs=60_000){
  const now = Date.now();
  const hit = RL.get(key) || { n:0, t:now };
  if (now - hit.t > windowMs) { hit.n = 0; hit.t = now; }
  hit.n++;
  RL.set(key, hit);
  return hit.n <= limit;
}

/* ---------------- db helpers ---------------- */
async function findActiveCode(kind, value, channel){
  const q = await pool.query(
    `
    SELECT id, member_id, identifier_kind, identifier_value, channel, code, attempts,
           expires_at, created_at, consumed_at
      FROM ff_identity_code
     WHERE identifier_kind=$1
       AND identifier_value=$2
       AND channel=$3
       AND consumed_at IS NULL
       AND (is_active = true OR expires_at > now())
     ORDER BY created_at DESC
     LIMIT 1
    `,
    [kind, value, channel]
  );
  return q.rows[0] || null;
}

async function insertCode({ memberIdForFK, kind, value, channel, ttlMinutes=12 }) {
  const code = sixDigit();
  const ins = await pool.query(
    `
    INSERT INTO ff_identity_code
      (member_id, identifier_kind, identifier_value, channel, code, attempts, expires_at, created_at, is_active)
    VALUES
      ($1,        $2,              $3,              $4,      $5,   0,        now() + ($6 || ' minutes')::interval, now(), true)
    RETURNING id, member_id, identifier_kind, identifier_value, channel, code, attempts, expires_at, created_at, consumed_at
    `,
    [memberIdForFK, kind, value, channel, code, String(ttlMinutes)]
  );
  return ins.rows[0] || null;
}

/* ---------------- main route ---------------- */

router.post('/request-code', async (req, res) => {
  const t0 = Date.now();
  try {
    const { identifier } = req.body || {};
    const { kind, value, channel, error } = normalizeIdentifier(identifier);
    if (error) return res.status(422).json({ ok:false, error:'invalid_identifier' });

    const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
    const rlKey = crypto.createHash('sha256').update(`${ip}:${kind}:${value}`).digest('hex');
    if (!rateLimit(rlKey)) return res.status(429).json({ ok:false, error:'rate_limited' });

    const cookieMemberId = (req.cookies?.ff_member || '').trim() || null;

    // (A) Prewrite to ff_quickhitter (non-blocking)
    if (cookieMemberId) {
      const colEmail = kind === 'email' ? value : null;
      const colPhone = kind === 'phone' ? value : null;
      pool.query(
        `
        INSERT INTO ff_quickhitter (member_id, email, phone, created_at, updated_at)
        VALUES ($1, $2, $3, now(), now())
        ON CONFLICT (member_id) DO UPDATE
        SET
          email = COALESCE(ff_quickhitter.email, EXCLUDED.email),
          phone = COALESCE(ff_quickhitter.phone, EXCLUDED.phone),
          updated_at = now()
        `,
        [cookieMemberId, colEmail, colPhone]
      ).catch(e => console.warn('[request-code] quickhitter upsert warn:', e?.message || e));
    }

    // (B) Try to reuse an active code
    let row = await findActiveCode(kind, value, channel);
    let reused = !!row;

    // (C) Ensure we have a row (create if missing), robust to FK & race
    if (!row) {
      try {
        // try with cookie member id first (if your FK points to ff_quickhitter)
        row = await insertCode({ memberIdForFK: cookieMemberId, kind, value, channel });
      } catch (e) {
        if (String(e.code) === '23503') {
          // FK violation → retry with NULL member_id
          row = await insertCode({ memberIdForFK: null, kind, value, channel });
        } else if (String(e.code) === '23505') {
          // unique race → select winner
          row = await findActiveCode(kind, value, channel);
          reused = true;
        } else {
          throw e;
        }
      }
    }

    // Last-resort safety: still nothing? create with NULL.
    if (!row) {
      row = await insertCode({ memberIdForFK: null, kind, value, channel }).catch(() => null);
      reused = false;
    }

// (D) Send the code (best-effort; don't block API on provider errors)
try {
  const theCode = row?.code || '000000';
  await sendOne({
    channel: channel === 'sms' ? 'sms' : 'email',
    to: value,
    // IMPORTANT: include { code } so templates can render it
    data: {
      code: theCode,
      subject: 'Your Fortified Fantasy code',
      text: `Your Fortified Fantasy verification code is: ${theCode}`
    },
    // optional: use explicit template ids if you have them configured
    templateId: channel === 'sms' ? 'ff_sms_code' : 'ff_email_code'
  });
} catch (e) {
  console.warn('NotificationAPI warning.', e?.status ? { status: e.status, body: e.body } : (e?.message || e));
}


    // (E) Safe response (guard if row is somehow null)
    const ttlMs = 12 * 60 * 1000;
    const fallbackExpiry = new Date(Date.now() + ttlMs).toISOString();

    return res.json({
      ok: true,
      kind,
      channel,
      to: mask(kind, value),
      expires_at: row?.expires_at || fallbackExpiry,
      reused: !!reused,
      took_ms: Date.now() - t0
    });
  } catch (err) {
    console.error('[identity/request-code] error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
