// routes/identity-api.js
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const crypto = require('crypto');

/* ---------- DB ---------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

/* ---------- utils ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE = /^\+?[0-9\-\s().]{7,}$/;

function normalizeIdentifier(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (EMAIL_RE.test(v)) return v.toLowerCase();
  if (PHONE_RE.test(v)) return '+' + v.replace(/[^\d]/g, '');
  return v; // username or other identifier
}

// Replace the old generator with this:
function genInviteCode(len = 8) {
  // Unambiguous set (no 0/O or 1/I)
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  }
  return out; // e.g. 'X9K2F7QZ'
}


function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || 'ff-default-salt';
  return crypto.createHash('sha256').update(`${salt}|${ip || ''}`).digest('hex');
}

function firstLang(acceptLang = '') {
  // "en-US,en;q=0.9" -> "en-US"
  return (acceptLang.split(',')[0] || '').trim() || null;
}

/* ---------- CORS preflight (your global cors also handles it) ---------- */
router.options('/request-code', (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
  }
  res.set('Access-Control-Allow-Headers', 'content-type');
  res.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.sendStatus(204);
});

/* ---------- POST /api/identity/request-code ---------- */
// routes/identity-api.js  (excerpt)
router.post('/request-code', async (req, res) => {
  try {
    if (!req.is('application/json')) {
      return res.status(415).json({ ok:false, error:'unsupported_media_type' });
    }

    const { identifier, tz, locale, utm_source, utm_medium, utm_campaign, landing_url } = req.body || {};
    const idNorm = normalizeIdentifier(identifier);
    if (!idNorm) {
      return res.status(400).json({ ok:false, error:'bad_request', detail:'identifier required' });
    }

    const code = genInviteCode(8); // e.g. X9K2F7QZ

    // metadata
    const source   = (utm_source   || req.query.utm_source   || null) ?? null;
    const medium   = (utm_medium   || req.query.utm_medium   || null) ?? null;
    const campaign = (utm_campaign || req.query.utm_campaign || null) ?? null;

    const landing  = landing_url || req.body?.landingUrl || req.get('referer') || null;
    const referer  = req.get('referer') || null;
    const ua       = req.get('user-agent') || null;
    const iphash   = hashIp(req.headers['cf-connecting-ip'] || req.ip);
    const loc      = locale || firstLang(req.get('accept-language'));
    const timezone = tz || null;

    // 1) INSERT first
    const insert = await pool.query(
      `
      INSERT INTO ff_invite
        (interacted_code, invited_at, source, medium, campaign, landing_url, referrer,
         user_agent, ip_hash, locale, tz, first_identifier)
      VALUES
        ($1, NOW(), $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11)
      RETURNING invite_id
      `,
      [code, source, medium, campaign, landing, referer, ua, iphash, loc, timezone, idNorm]
    );

    const inviteId = insert.rows[0].invite_id;

    // 2) Tag source with ffint-CODE (return address)
    await pool.query(
      `UPDATE ff_invite
         SET source = COALESCE(NULLIF(source,''),'web') || ':ffint-' || $1
       WHERE invite_id = $2`,
      [code, inviteId]
    );

    // 3) Build redirect URL for your signup page
    // swap base if you want to use your CF Pages preview domain while testing
    const base = 'https://fortifiedfantasy.com';
    // const base = 'https://85194fdc.fortifiedfantasyfootball.pages.dev';
    const signupUrl = `${base}/signup?source=${encodeURIComponent('ffint-' + code)}`;

    console.log('[request-code] invite_id=%s code=%s id=%s', inviteId, code, idNorm);

    return res.status(200).json({
      ok: true,
      invite_id: inviteId,
      interacted_code: code,
      signup_url: signupUrl
    });
  } catch (err) {
    console.error('identity.request-code error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
