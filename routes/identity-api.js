// routes/identity-api.js
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

/* ---------- utils ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE = /^\+?[0-9\-\s().]{7,}$/;
const HANDLE_RE = /^[a-zA-Z0-9_.]{3,24}$/;

function normalizeIdentifier(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (EMAIL_RE.test(v)) return v.toLowerCase();
  if (PHONE_RE.test(v)) return '+' + v.replace(/[^\d]/g, '');
  return v; // candidate username/handle
}

function classifyIdentifier(idNorm) {
  if (EMAIL_RE.test(idNorm)) return 'email';
  if (/^\+\d{7,}$/.test(idNorm)) return 'phone';
  if (HANDLE_RE.test(idNorm)) return 'handle';
  return 'other';
}

function genInviteCode(len = 8) {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  return out;
}

function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || 'ff-default-salt';
  return crypto.createHash('sha256').update(`${salt}|${ip || ''}`).digest('hex');
}

function firstLang(acceptLang = '') {
  return (acceptLang.split(',')[0] || '').trim() || null;
}

/* ---------- CORS preflight ---------- */
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
router.post('/request-code', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!req.is('application/json')) {
      return res.status(415).json({ ok:false, error:'unsupported_media_type' });
    }

    const { identifier, tz, locale, utm_source, utm_medium, utm_campaign, landing_url, color_hex } = req.body || {};
    const idNorm = normalizeIdentifier(identifier);
    if (!idNorm) {
      return res.status(400).json({ ok:false, error:'bad_request', detail:'identifier required' });
    }

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

    const code = genInviteCode(8); // X9K2F7QZ etc.

    await client.query('BEGIN');

    // 1) INSERT invite
    const insertInvite = await client.query(
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
    const inviteId = insertInvite.rows[0].invite_id;

    await client.query(
      `UPDATE ff_invite
         SET source = COALESCE(NULLIF(source,''),'web') || ':ffint-' || $1
       WHERE invite_id = $2`,
      [code, inviteId]
    );

    // 2) UPSERT member on interacted_code
    const kind = classifyIdentifier(idNorm);
    const emailVal  = kind === 'email'  ? idNorm : null;
    const phoneVal  = kind === 'phone'  ? idNorm : null;
    const handleVal = kind === 'handle' ? idNorm : null;

    // Pick color: prefer validated incoming, else default DB default
    const color = (typeof color_hex === 'string' && /^#[0-9A-Fa-f]{6}$/.test(color_hex))
      ? color_hex.toUpperCase()
      : null;

    // Create if missing; if exists, do not overwrite existing email/phone/username,
    // just refresh last_seen_at, last_referrer, last_page, etc.
    const upsertMember = await client.query(
      `
      INSERT INTO ff_member
        (interacted_code, email, phone_e164, username,
         first_seen_at, last_seen_at, user_agent, ip_hash, locale, tz,
         first_referrer, last_referrer, first_page, last_page, color_hex)
      VALUES
        ($1,
         $2, $3, $4,
         NOW(), NOW(), $5, $6, $7, $8,
         $9, $10, $11, $12, COALESCE($13, DEFAULT(ff_member.color_hex)))
      ON CONFLICT (interacted_code) DO UPDATE
        SET last_seen_at = NOW(),
            last_referrer = EXCLUDED.last_referrer,
            last_page     = EXCLUDED.last_page,
            user_agent    = EXCLUDED.user_agent,
            locale        = COALESCE(ff_member.locale, EXCLUDED.locale),
            tz            = COALESCE(ff_member.tz, EXCLUDED.tz),
            -- only set identifiers if currently empty (never overwrite)
            email         = COALESCE(ff_member.email, EXCLUDED.email),
            phone_e164    = COALESCE(ff_member.phone_e164, EXCLUDED.phone_e164),
            username      = COALESCE(ff_member.username, EXCLUDED.username),
            color_hex     = COALESCE(ff_member.color_hex, EXCLUDED.color_hex)
      RETURNING member_id
      `,
      [
        code,
        emailVal, phoneVal, handleVal,
        ua, iphash, loc, timezone,
        referer, referer, landing, landing,
        color
      ]
    );
    const memberId = upsertMember.rows[0].member_id;

    // 3) Link invite → member
    await client.query(
      `UPDATE ff_invite SET member_id = $1 WHERE invite_id = $2`,
      [memberId, inviteId]
    );

    await client.query('COMMIT');

    // 4) Build signup redirect
    const base = 'https://fortifiedfantasy.com';
    const signupUrl = `${base}/signup?source=${encodeURIComponent('ffint-' + code)}`;

    return res.status(200).json({
      ok: true,
      invite_id: inviteId,
      interacted_code: code,
      member_id: memberId,
      signup_url: signupUrl
    });
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch {}
    console.error('identity.request-code error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  } finally {
    client.release();
  }
});

module.exports = router;
