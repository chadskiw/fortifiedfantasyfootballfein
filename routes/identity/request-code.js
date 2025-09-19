// routes/identity-api/request-code.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Reuse pool from server.js
const { pool } = require('../server');

/* ---------- validators / helpers ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE = /^\+?[0-9\-\s().]{7,}$/;

function normalizeIdentifier(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (EMAIL_RE.test(v)) return v.toLowerCase();
  if (PHONE_RE.test(v)) return '+' + v.replace(/[^\d]/g, '');
  return v;
}

function genInviteCode(len = 8) {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  }
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

    const { identifier, tz, locale, utm_source, utm_medium, utm_campaign, landing_url } =
      req.body || {};
    const idNorm = normalizeIdentifier(identifier);
    if (!idNorm) {
      return res
        .status(400)
        .json({ ok: false, error: 'bad_request', detail: 'identifier required' });
    }

    const kind = EMAIL_RE.test(idNorm)
      ? 'email'
      : PHONE_RE.test(idNorm)
      ? 'phone'
      : 'handle';

    const code = genInviteCode(8);
    const source = utm_source ?? req.query.utm_source ?? null;
    const medium = utm_medium ?? req.query.utm_medium ?? null;
    const campaign = utm_campaign ?? req.query.utm_campaign ?? null;

    const landing = landing_url || req.body?.landingUrl || req.get('referer') || null;
    const referer = req.get('referer') || null;
    const ua = req.get('user-agent') || null;
    const clientIp = req.headers['cf-connecting-ip'] || req.ip;
    const iphash = hashIp(clientIp);
    const loc = locale || firstLang(req.get('accept-language'));
    const timezone = tz || null;

    /* ---------- Insert into ff_invite ---------- */
    let inviteId;
    try {
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
      inviteId = insert.rows[0]?.invite_id;
    } catch (err) {
      console.error('ff_invite insert error:', err.message, err.detail || '');
      throw err;
    }

    // Tag source
    await pool.query(
      `UPDATE ff_invite
         SET source = COALESCE(NULLIF(source,''),'web') || ':ffint-' || $1
       WHERE invite_id = $2`,
      [code, inviteId]
    ).catch((err) => console.warn('ff_invite source tag warn:', err.message));

    /* ---------- Opportunistic insert into ff_member ---------- */
    try {
      const cols = [
        'interacted_code',
        'first_seen_at',
        'last_seen_at',
        'user_agent',
        'ip_hash',
        'locale',
        'tz',
        'color_hex'
      ];
      const vals = [code, 'NOW()', 'NOW()', '$UA$', '$IPHASH$', '$LOC$', '$TZ$', "'#FFFFFF'"];

      if (kind === 'email') cols.push('email') && vals.push('$IDENT$');
      if (kind === 'phone') cols.push('phone_e164') && vals.push('$IDENT$');
      if (kind === 'handle') cols.push('username') && vals.push('$IDENT$');

      const sql = `
        INSERT INTO ff_member (${cols.join(',')})
        VALUES (${vals
          .map((v) =>
            v
              .replace('$UA$', `'${(ua || '').replace(/'/g, "''")}'`)
              .replace('$IPHASH$', `'${iphash}'`)
              .replace('$LOC$', loc ? `'${String(loc).replace(/'/g, "''")}'` : 'NULL')
              .replace('$TZ$', timezone ? `'${String(timezone).replace(/'/g, "''")}'` : 'NULL')
              .replace('$IDENT$', `'${String(idNorm).replace(/'/g, "''")}'`)
          )
          .join(',')})
        ON CONFLICT DO NOTHING
      `;
      await pool.query(sql);
    } catch (err) {
      console.warn('ff_member insert warn:', err.message);
    }

    /* ---------- Build signup URL ---------- */
    const siteBase = process.env.PUBLIC_SITE_ORIGIN || 'https://fortifiedfantasy.com';
    const params = new URLSearchParams({ source: `ffint-${code}` });
    if (kind === 'email') params.set('email', idNorm);
    if (kind === 'phone') params.set('phone', idNorm);
    if (kind === 'handle') params.set('handle', idNorm);

    const signupUrl = `${siteBase}/signup?${params.toString()}`;

    /* ---------- Set cookies ---------- */
    res.cookie(
      'ff.pre.signup',
      encodeURIComponent(
        JSON.stringify({
          firstIdentifier: idNorm,
          type: kind
        })
      ),
      { httpOnly: false, sameSite: 'Lax', secure: !!req.secure, path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 }
    );

    res.cookie('ff-interacted', '1', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
      maxAge: 31536000000
    });

    /* ---------- Response ---------- */
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
