// routes/identity-api/request-code.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Reuse the pool created in server.js (avoids multiple connections)
const { pool } = require('../db');

/* ---------- validators / helpers ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE = /^\+?[0-9\-\s().]{7,}$/;

function normalizeIdentifier(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (EMAIL_RE.test(v)) return v.toLowerCase();
  if (PHONE_RE.test(v)) return '+' + v.replace(/[^\d]/g, '');
  return v; // treat as handle/username
}

// unambiguous 8-char invite code (no 0/O or 1/I)
function genInviteCode(len = 8) {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  return out;
}

function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || 'ff-default-salt';
  return crypto.createHash('sha256').update(`${salt}|${ip || ''}`).digest('hex');
}
function firstLang(h = '') {
  return (h.split(',')[0] || '').trim() || null;
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
  try {
    if (!req.is('application/json')) {
      return res.status(415).json({ ok: false, error: 'unsupported_media_type' });
    }

    const { identifier, tz, locale, utm_source, utm_medium, utm_campaign, landing_url } = req.body || {};
    const idNorm = normalizeIdentifier(identifier);
    if (!idNorm) {
      return res.status(400).json({ ok: false, error: 'bad_request', detail: 'identifier required' });
    }

    const kind =
      EMAIL_RE.test(idNorm) ? 'email' :
      PHONE_RE.test(idNorm) ? 'phone' : 'handle';

    const code     = genInviteCode(8);
    const source   = utm_source   ?? req.query.utm_source   ?? null;
    const medium   = utm_medium   ?? req.query.utm_medium   ?? null;
    const campaign = utm_campaign ?? req.query.utm_campaign ?? null;

    const landing  = landing_url || req.body?.landingUrl || req.get('referer') || null;
    const referer  = req.get('referer') || null;
    const ua       = req.get('user-agent') || null;

    // make sure your app is set('trust proxy', true) so req.ip is sane
    const clientIp = req.headers['cf-connecting-ip'] || req.ip;
    const iphash   = hashIp(clientIp);
    const loc      = locale || firstLang(req.get('accept-language'));
    const timezone = tz || null;

    /* 1) INSERT invite (parameterized) */
    const insertInviteSQL = `
      INSERT INTO ff_invite
        (interacted_code, invited_at, source, medium, campaign, landing_url, referrer,
         user_agent, ip_hash, locale, tz, first_identifier)
      VALUES
        ($1, NOW(), $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11)
      RETURNING invite_id
    `;
    const inviteVals = [code, source, medium, campaign, landing, referer, ua, iphash, loc, timezone, idNorm];

    let inviteId;
    try {
      const ins = await pool.query(insertInviteSQL, inviteVals);
      inviteId = ins.rows[0]?.invite_id;
    } catch (err) {
      console.error('ff_invite insert error:', err.message, err.detail || '');
      throw err;
    }

    /* 2) Tag source with ffint-CODE (not critical if it fails) */
    try {
      await pool.query(
        `UPDATE ff_invite
           SET source = COALESCE(NULLIF(source,''),'web') || ':ffint-' || $1
         WHERE invite_id = $2`,
        [code, inviteId]
      );
    } catch (err) {
      console.warn('ff_invite source tag warn:', err.message);
    }

    /* 3) Opportunistic member seed (parameterized) */
    try {
      let memberSQL = '';
      let memberVals = [];

      if (kind === 'email') {
        memberSQL = `
          INSERT INTO ff_member
            (interacted_code, first_seen_at, last_seen_at,
             user_agent, ip_hash, locale, tz, color_hex, email)
          VALUES
            ($1, NOW(), NOW(),
             $2, $3, $4, $5,
             COALESCE($6, '#FFFFFF'), $7)
          ON CONFLICT DO NOTHING
        `;
        memberVals = [code, ua, iphash, loc, timezone, null, idNorm];
      } else if (kind === 'phone') {
        memberSQL = `
          INSERT INTO ff_member
            (interacted_code, first_seen_at, last_seen_at,
             user_agent, ip_hash, locale, tz, color_hex, phone_e164)
          VALUES
            ($1, NOW(), NOW(),
             $2, $3, $4, $5,
             COALESCE($6, '#FFFFFF'), $7)
          ON CONFLICT DO NOTHING
        `;
        memberVals = [code, ua, iphash, loc, timezone, null, idNorm];
      } else { // handle
        memberSQL = `
          INSERT INTO ff_member
            (interacted_code, first_seen_at, last_seen_at,
             user_agent, ip_hash, locale, tz, color_hex, username)
          VALUES
            ($1, NOW(), NOW(),
             $2, $3, $4, $5,
             COALESCE($6, '#FFFFFF'), $7)
          ON CONFLICT DO NOTHING
        `;
        memberVals = [code, ua, iphash, loc, timezone, null, idNorm];
      }


      await pool.query(memberSQL, memberVals);
    } catch (err) {
      console.warn('ff_member insert warn:', err.message);
      // non-fatal
    }

    /* 4) Build signup URL with prefill params */
    const siteBase = process.env.PUBLIC_SITE_ORIGIN || 'https://fortifiedfantasy.com';
    const params = new URLSearchParams({ source: `ffint-${code}` });
    if (kind === 'email')  params.set('email',  idNorm);
    if (kind === 'phone')  params.set('phone',  idNorm);
    if (kind === 'handle') params.set('handle', idNorm);
    const signupUrl = `${siteBase}/signup?${params.toString()}`;

    /* 5) Light prefill cookie for the frontend (optional) */
    try {
      const pre = {
        firstIdentifier: idNorm,
        type: kind,
        pending: kind === 'email' ? { email: idNorm }
               : kind === 'phone' ? { phone: idNorm }
               : null
      };
      res.cookie('ff.pre.signup', encodeURIComponent(JSON.stringify(pre)), {
        httpOnly: false,
        sameSite: 'Lax',
        secure: !!req.secure,
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000
      });
    } catch {}

    /* 6) Interaction marker cookie (your original) */
    try {
      res.cookie('ff-interacted', '1', {
        httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: 31536000000
      });
    } catch {}

    return res.status(200).json({
      ok: true,
      invite_id: inviteId,
      interacted_code: code,
      signup_url: signupUrl
    });

  } catch (e) {
    console.error('identity.request-code error:', e.message, e.detail || '');
    return res.status(500).json({
      ok: false,
      error: 'server_error',
      code: e.code || null,
      detail: e.detail || null,
      message: e.message || null
    });
  }
});

module.exports = router;
