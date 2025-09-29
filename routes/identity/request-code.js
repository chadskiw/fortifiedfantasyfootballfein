// routes/identity/request-code.js
// Mount with: app.use('/api/identity', require('./routes/identity/request-code'));

const express = require('express');
const crypto  = require('crypto');
const pool    = require('../../src/db/pool');
const { sendOne } = require('../../services/notify'); // your notify.js shim

const router = express.Router();
router.use(express.json({ limit: '2mb' }));
router.use(express.urlencoded({ extended: false }));

/* ---------------- utils ---------------- */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE  = /^\+[1-9]\d{7,14}$/;

function toE164(raw){
  if (!raw) return null;
  const d = String(raw).replace(/\D+/g,'');
  if (!d) return null;
  if (d.length === 10) return `+1${d}`;           // US local → +1XXXXXXXXXX
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
  const e164 = toE164(raw);
  if (e164 && E164_RE.test(e164)) {
    return { kind:'phone', value: e164, channel:'sms' };
  }
  return { kind:null, value:null, channel:null, error:'invalid_identifier' };
}

function sixDigit(){
  // cryptographically strong 6-digit numeric code
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}

function maskIdentifier(kind, value){
  if (kind === 'email') {
    try {
      const [user, host] = value.split('@');
      const u = user.length <= 2 ? user : (user[0] + '***' + user.slice(-1));
      const h = host.replace(/^(.)(.*)(\..*)$/, (_,a,b,c)=> a + '***' + c);
      return `${u}@${h}`;
    } catch { return value; }
  }
  if (kind === 'phone') {
    return value.replace(/^(\+\d{0,2})\d+(?=\d{2}$)/, (_,cc)=> cc + '***'); // keep country & last 2
  }
  return value;
}

/* ---------------- rate limit (very light) ---------------- */

const RL_BUCKET = new Map(); // memory-per-process; OK for Render / single dyno
function rateLimit(key, limit = 6, windowMs = 60_000){
  const now = Date.now();
  const hit = RL_BUCKET.get(key) || { n:0, t: now };
  if (now - hit.t > windowMs) { hit.n = 0; hit.t = now; }
  hit.n++;
  RL_BUCKET.set(key, hit);
  return hit.n <= limit;
}

/* ---------------- main ---------------- */

/**
 * POST /api/identity/request-code
 * body: { identifier: string }
 *
 * Behavior:
 *  - Upsert the contact into ff_quickhitter for the current cookie member_id (if present)
 *  - Look for an existing, active code for (kind, value, channel); if present, reuse it
 *  - Else create a new code row (carrying member_id if available)
 *  - Send the code via NotificationAPI shim (best-effort; never throws at caller)
 */
router.post('/request-code', async (req, res) => {
  const started = Date.now();

  try {
    const { identifier } = req.body || {};
    const { kind, value, channel, error } = normalizeIdentifier(identifier);
    if (error || !kind) {
      return res.status(422).json({ ok:false, error:'invalid_identifier', message:'Provide a valid email or +E164 phone.' });
    }

    // simple IP+value rate limit
    const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
    const key = crypto.createHash('sha256').update(`${ip}::${kind}:${value}`).digest('hex');
    if (!rateLimit(key, 6, 60_000)) {
      return res.status(429).json({ ok:false, error:'rate_limited' });
    }

    // carry member_id from cookies if present
    const cookieMemberId = (req.cookies?.ff_member || '').trim() || null;

    // 1) UPSERT into ff_quickhitter *before* we write code
    //    (only if we have a member cookie)
    if (cookieMemberId) {
      const now = new Date();
      const cols = {
        email : kind === 'email' ? value : null,
        phone : kind === 'phone' ? value : null,
      };

      // We never overwrite a *verified* contact here; we only set the pending value
      // if that column is currently NULL or equals the same value.
      await pool.query(
        `
        INSERT INTO ff_quickhitter (member_id, email, phone, updated_at, created_at)
        VALUES ($1, $2, $3, $4, $4)
        ON CONFLICT (member_id) DO UPDATE
        SET
          email = COALESCE(ff_quickhitter.email, EXCLUDED.email),
          phone = COALESCE(ff_quickhitter.phone, EXCLUDED.phone),
          updated_at = EXCLUDED.updated_at
        `,
        [cookieMemberId, cols.email, cols.phone, now]
      ).catch((e) => {
        // Non-fatal: if the row belongs to another, the quickhitter/upsert route handles that.
        // Here we just avoid blocking code send.
        console.warn('[request-code] quickhitter upsert warn:', e?.message || e);
      });
    }

    // 2) Reuse active code if exists; else create new
    let codeRow = null;

    const reuse = await pool.query(
      `
      SELECT id, member_id, identifier_kind, identifier_value, channel, code,
             attempts, expires_at, created_at, consumed_at
        FROM ff_identity_code
       WHERE identifier_kind=$1
         AND identifier_value=$2
         AND channel=$3
         AND consumed_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1
      `,
      [kind, value, channel]
    );

    if (reuse.rowCount) {
      codeRow = reuse.rows[0];
    } else {
      const code = sixDigit();
      const expiryMinutes = 12; // generous window
      const expiresAtSql = `now() + interval '${expiryMinutes} minutes'`;

      const ins = await pool.query(
        `
        INSERT INTO ff_identity_code
          (member_id, identifier_kind, identifier_value, channel, code, attempts, expires_at, created_at)
        VALUES
          ($1,        $2,              $3,              $4,      $5,   0,        ${expiresAtSql}, now())
        RETURNING id, member_id, identifier_kind, identifier_value, channel, code, attempts, expires_at, created_at, consumed_at
        `,
        [cookieMemberId, kind, value, channel, code]
      );
      codeRow = ins.rows[0];
    }

    // 3) Best-effort send (don’t make the route fail if a provider issue happens)
    try {
      await sendOne({
        channel: channel === 'sms' ? 'sms' : 'email',
        to: value,
        data: { code: codeRow.code, site: 'Fortified Fantasy' },
        templateId: channel === 'sms' ? 'smsDefault' : 'emailDefault'
      });
    } catch (e) {
      // notify.js already logs; we still succeed the API
    }

    const ms = Date.now() - started;
    return res.json({
      ok: true,
      kind,
      channel,
      to: maskIdentifier(kind, value),
      expires_at: codeRow.expires_at,
      reused: !!reuse.rowCount,
      took_ms: ms
    });

  } catch (err) {
    console.error('[identity/request-code] error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
