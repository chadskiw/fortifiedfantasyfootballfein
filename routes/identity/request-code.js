// routes/identity/request-code.js
// Mount: app.use('/api/identity', require('./routes/identity/request-code'));

const express = require('express');
const crypto  = require('crypto');
const pool    = require('../../src/db/pool');
const { sendOne } = require('../../services/notify'); // your notify shim

const router = express.Router();
router.use(express.json({ limit: '2mb' }));
router.use(express.urlencoded({ extended: false }));

/* ---------------- helpers ---------------- */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE  = /^\+[1-9]\d{7,14}$/;

function toE164(raw) {
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
  if (p && E164_RE.test(p)) {
    return { kind:'phone', value: p, channel:'sms' };
  }
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

/* ---------------- light in-proc ratelimit ---------------- */

const RL = new Map();
function rateLimit(key, limit=6, windowMs=60_000){
  const now = Date.now();
  const hit = RL.get(key) || { n:0, t:now };
  if (now - hit.t > windowMs) { hit.n = 0; hit.t = now; }
  hit.n++;
  RL.set(key, hit);
  return hit.n <= limit;
}

/* ---------------- route ---------------- */

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

    // (A) Prewrite contact to ff_quickhitter (ownership scratchpad) — does NOT promote.
    if (cookieMemberId) {
      const colEmail = kind === 'email' ? value : null;
      const colPhone = kind === 'phone' ? value : null;
      await pool.query(
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

    // (B) Create a new code OR atomically reuse the existing active one.
    //     Your unique constraint name is: ff_identity_code_one_active
    //     We use ON CONFLICT ON CONSTRAINT to avoid 23505 races and RETURN existing.
    const newCode = sixDigit();
    const ins = await pool.query(
      `
      WITH up AS (
        INSERT INTO ff_identity_code
          (member_id, identifier_kind, identifier_value, channel, code, attempts, expires_at, created_at)
        VALUES
          ($1,        $2,              $3,              $4,      $5,   0,        now() + interval '12 minutes', now())
        ON CONFLICT ON CONSTRAINT ff_identity_code_one_active
        DO UPDATE SET
          -- do NOT overwrite the existing code; just keep it & preserve expiry
          member_id = COALESCE(ff_identity_code.member_id, EXCLUDED.member_id)
        RETURNING id, member_id, identifier_kind, identifier_value, channel, code, attempts, expires_at, created_at, consumed_at,
                  (xmax = 0) AS inserted
      )
      SELECT * FROM up
      `,
      [cookieMemberId, kind, value, channel, newCode]
    );

    const row = ins.rows[0];
    const reused = !row.inserted;

    // (C) Best-effort send (never fail the API on provider hiccups)
    try {
      await sendOne({
        channel: channel === 'sms' ? 'sms' : 'email',
        to: value,
        data: { code: row.code, site: 'Fortified Fantasy' },
        templateId: channel === 'sms' ? 'smsDefault' : 'emailDefault'
      });
    } catch (e) {
      // log inside notify; continue
    }

    return res.json({
      ok: true,
      kind,
      channel,
      to: mask(kind, value),
      expires_at: row.expires_at,
      reused,
      took_ms: Date.now() - t0
    });
  } catch (err) {
    console.error('[identity/request-code] error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
