// routes/whoami.js
// Provides:
//   GET /check           → session summary (safe, anon OK)
//   GET /lookup?identifier=... → existence check (email/phone/handle), safe boolean

const express = require('express');
const router  = express.Router();
const pool    = require('../src/db/pool'); // pg Pool (src/db/pool.js)

if (!pool) throw new Error('[whoami] pg pool missing');

// ---- helpers ----
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE  = /^\+?[0-9\-\s().]{7,}$/;
const HANDLE_RE = /^[a-zA-Z0-9_.](?:[a-zA-Z0-9_. ]{1,22})[a-zA-Z0-9_.]$/;

function normalizeIdentifier(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: null, value: null };

  if (EMAIL_RE.test(s)) return { kind: 'email', value: s.toLowerCase() };

  if (PHONE_RE.test(s)) {
    const digits = s.replace(/[^\d]/g, '');
    const e164 = digits.startsWith('1') && digits.length === 11 ? `+${digits}`
                : digits.length === 10 ? `+1${digits}`
                : `+${digits}`;
    return { kind: 'phone', value: e164 };
  }

  if (HANDLE_RE.test(s)) {
    const handle = s.replace(/\s{2,}/g, ' ');
    return { kind: 'handle', value: handle };
  }
  return { kind: null, value: null };
}

async function fetchMember(member_id) {
  if (!member_id) return null;
  const { rows } = await pool.query(`
    SELECT member_id, username, email, phone_e164, color_hex,
           email_verified_at, phone_verified_at, auth_verified_at
      FROM ff_member
     WHERE deleted_at IS NULL AND member_id = $1
     LIMIT 1
  `, [member_id]);
  return rows[0] || null;
}

// ---- routes ----

// Session status (safe). Reads ff_member cookie, returns minimal session info.
router.get('/check', async (req, res) => {
  try {
    const memberId = req.cookies?.ff_member || null;
    const m = await fetchMember(memberId);

    const out = m ? {
      ok: true,
      anon: false,
      member_id: m.member_id,
      username: m.username || null,
      color_hex: m.color_hex || null,
      email_verified: !!m.email_verified_at,
      phone_verified: !!m.phone_verified_at,
      auth_verified:  !!m.auth_verified_at,
      source: 'platform-service'
    } : {
      ok: true, anon: true, source: 'platform-service'
    };

    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) {
    console.error('[whoami]/check error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Existence check (safe boolean). Prevents PII leaks.
router.get('/lookup', async (req, res) => {
  try {
    const { kind, value } = normalizeIdentifier(req.query.identifier);
    if (!value) return res.status(422).json({ ok: false, error: 'invalid_identifier' });

    const where =
      kind === 'email'  ? 'LOWER(email)=LOWER($1)' :
      kind === 'phone'  ? 'phone_e164=$1' :
      kind === 'handle' ? 'LOWER(username)=LOWER($1)' : '1=0';

    const { rows } = await pool.query(`SELECT 1 FROM ff_member WHERE ${where} AND deleted_at IS NULL LIMIT 1`, [value]);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, kind, normalized: value, exists: !!rows[0] });
  } catch (e) {
    console.error('[whoami]/lookup error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
