// routes/identity/verify-code.js
const express = require('express');
const crypto  = require('crypto');

let db = require('../../src/db/pool');
let pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[identity/verify-code] pg pool missing/invalid import');
}

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

// ------- helpers -------
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE  = /^\+[1-9]\d{7,14}$/;
const CODE_RE  = /^\d{6}$/;

const ENV   = String(process.env.NODE_ENV || '').trim() || 'development';
const DEBUG = process.env.FF_DEBUG_VERIFY === '1';

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
  if (EMAIL_RE.test(raw)) return { kind:'email', value: raw.toLowerCase(), channel:'email' };
  const p = toE164(raw);
  if (p && E164_RE.test(p)) return { kind:'phone', value:p, channel:'sms' };
  return { kind:null, value:null, channel:null, error:'invalid_identifier' };
}
function ensureMemberId(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z0-9]{8}$/.test(s)) return s;
  return crypto.randomBytes(8).toString('base64').replace(/[^A-Z0-9]/gi,'').slice(0,8).toUpperCase();
}

// ------- route -------
// POST /api/identity/verify-code  { identifier, code }
router.post('/verify-code', async (req, res) => {
  const t0 = Date.now();
  try {
    const { identifier, code } = req.body || {};
    if (!CODE_RE.test(String(code || ''))) {
      return res.status(422).json({ ok:false, error:'invalid_code' });
    }
    const { kind, value, channel, error } = normalizeIdentifier(identifier);
    if (error) return res.status(422).json({ ok:false, error:'invalid_identifier' });

    if (DEBUG) console.log('[verify] try', { kind, value, channel, code });

    // ---- Find latest active code for this identifier+channel (no member filter) ----
    let sel;
    if (kind === 'phone') {
      // Match by digits-only to tolerate +, spaces, parentheses, or rows stored without '+'
      sel = await pool.query(
        `
        SELECT id, member_id, code, attempts, expires_at, created_at, identifier_value
          FROM ff_identity_code
         WHERE identifier_kind = 'phone'
           AND channel = 'sms'
           AND REGEXP_REPLACE(identifier_value, '\\D', '', 'g') = REGEXP_REPLACE($1, '\\D', '', 'g')
           AND consumed_at IS NULL
           AND (is_active = true OR expires_at > now())
         ORDER BY created_at DESC
         LIMIT 1
        `,
        [value]
      );
    } else {
      sel = await pool.query(
        `
        SELECT id, member_id, code, attempts, expires_at, created_at, identifier_value
          FROM ff_identity_code
         WHERE identifier_kind = 'email'
           AND channel = 'email'
           AND LOWER(identifier_value) = LOWER($1)
           AND consumed_at IS NULL
           AND (is_active = true OR expires_at > now())
         ORDER BY created_at DESC
         LIMIT 1
        `,
        [value]
      );
    }

    const row = sel.rows[0] || null;
    if (DEBUG) console.log('[verify] found row?', !!row, row && {
      id: row.id, attempts: row.attempts, member_id: row.member_id,
      created_at: row.created_at, identifier_value: row.identifier_value
    });

    if (!row) return res.status(400).json({ ok:false, error:'invalid_or_expired' });

    if (String(row.code) !== String(code)) {
      const bumped = Math.min((row.attempts || 0) + 1, 10);
      await pool.query(`UPDATE ff_identity_code SET attempts=$1 WHERE id=$2`, [bumped, row.id]);
      if (DEBUG) console.log('[verify] mismatch, attempts ->', bumped);
      return res.status(400).json({ ok:false, error:'invalid_or_expired' });
    }

    // ---- Success: consume and link to this cookie member ----
    const memberId = ensureMemberId(req.cookies?.ff_member);
    await pool.query(
      `UPDATE ff_identity_code
          SET consumed_at = now(),
              is_active   = false,
              member_id   = COALESCE(member_id, $1)
        WHERE id = $2`,
      [memberId, row.id]
    );

    // Stage verification into ff_quickhitter for THIS session
    if (kind === 'email') {
      await pool.query(
        `INSERT INTO ff_quickhitter (member_id, email, email_is_verified, created_at, updated_at)
         VALUES ($1, $2, true, now(), now())
         ON CONFLICT (member_id) DO UPDATE
           SET email = $2, email_is_verified = true, updated_at = now()`,
        [memberId, value]
      );
    } else {
      await pool.query(
        `INSERT INTO ff_quickhitter (member_id, phone, phone_is_verified, created_at, updated_at)
         VALUES ($1, $2, true, now(), now())
         ON CONFLICT (member_id) DO UPDATE
           SET phone = $2, phone_is_verified = true, updated_at = now()`,
        [memberId, value]
      );
    }

    // refresh cookie
    res.cookie('ff_member', memberId, { httpOnly:true, secure:true, sameSite:'Lax', maxAge: 365*24*3600*1000 });

    return res.json({ ok:true, verified: kind, member_id: memberId, took_ms: Date.now() - t0 });
  } catch (e) {
    console.error('[identity/verify-code] error:', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
