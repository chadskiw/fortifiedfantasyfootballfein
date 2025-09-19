// routes/identity-api/request-code.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Reuse pool from server.js (export { pool } there)
const { pool } = require('../server');

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

function genInviteCode(len = 8) {
  // unambiguous (no 0/O or 1/I)
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  return out;
}

function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || 'ff-default-salt';
  return crypto.createHash('sha256').update(`${salt}|${ip || ''}`).digest('hex');
}
function firstLang(h = '') { return (h.split(',')[0] || '').trim() || null; }

/* ---------- CORS preflight ---------- */
router.options('/request-code', (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary','Origin');
    res.set('Access-Control-Allow-Credentials','true');
  }
  res.set('Access-Control-Allow-Headers','content-type');
  res.set('Access-Control-Allow-Methods','POST,OPTIONS');
  res.sendStatus(204);
});

/* ---------- POST /api/identity/request-code ---------- */
router.post('/request-code', async (req, res) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ ok:false, error:'unsupported_media_type' });
  }

  const { identifier, tz, locale, utm_source, utm_medium, utm_campaign, landing_url } = req.body || {};
  const idNorm = normalizeIdentifier(identifier);
  if (!idNorm) {
    return res.status(400).json({ ok:false, error:'bad_request', detail:'identifier required' });
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

  // prefer CDN/proxy header if behind CF/Render; also set app.set('trust proxy', true)
  const clientIp = req.headers['cf-connecting-ip'] || req.ip;
  const iphash   = hashIp(clientIp);
  const loc      = locale || firstLang(req.get('accept-language'));
  const timezone = tz || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* 1) INSERT invite */
    let inviteId;
    try {
      const r = await client.query(
        `INSERT INTO ff_invite
           (interacted_code, invited_at, source, medium, campaign, landing_url, referrer,
            user_agent, ip_hash, locale, tz, first_identifier)
         VALUES
           ($1, NOW(), $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11)
         RETURNING invite_id`,
        [code, source, medium, campaign, landing, referer, ua, iphash, loc, timezone, idNorm]
      );
      inviteId = r.rows[0]?.invite_id;
    } catch (err) {
      console.error('[invite.insert] ERROR', { message: err.message, code: err.code, detail: err.detail });
      throw err; // triggers ROLLBACK
    }

    /* 2) Tag source with ffint-CODE (not critical if it fails) */
    try {
      await client.query(
        `UPDATE ff_invite
           SET source = COALESCE(NULLIF(source,''), 'web') || ':ffint-' || $1
         WHERE invite_id = $2`,
        [code, inviteId]
      );
    } catch (err) {
      console.warn('[invite.tag] WARN', { message: err.message, code: err.code, detail: err.detail });
      // non-fatal
    }

    /* 3) Opportunistic member insert (ignore conflicts) */
    try {
      // Build dynamic column/value arrays
      const cols = ['interacted_code', 'first_seen_at', 'last_seen_at', 'user_agent', 'ip_hash', 'locale', 'tz', 'color_hex'];
      const vals = [code, /* NOW() */ /* NOW() */ ua, iphash, loc, timezone, '#FFFFFF'];
      // $ placeholders: interacted_code is $1 above? We're in a new statement, so place them fresh.
      // We'll use NOW() inline, everything else param’d.

      if (kind === 'email')  { cols.push('email');      vals.push(idNorm); }
      if (kind === 'phone')  { cols.push('phone_e164'); vals.push(idNorm); }
      if (kind === 'handle') { cols.push('username');   vals.push(idNorm); }

      // Build param list: interacted_code is first param again here
      // We want: interacted_code, NOW(), NOW(), user_agent, ip_hash, locale, tz, color_hex, [identifier?]
      const params = [];
      const placeholders = [];
      let i = 1;

      // interacted_code
      params.push(code); placeholders.push(`$${i++}`);
      // NOW()
      placeholders.push('NOW()');
      // NOW()
      placeholders.push('NOW()');
      // user_agent
      params.push(ua || null); placeholders.push(`$${i++}`);
      // ip_hash
      params.push(iphash); placeholders.push(`$${i++}`);
      // locale
      params.push(loc || null); placeholders.push(`$${i++}`);
      // tz
      params.push(timezone || null); placeholders.push(`$${i++}`);
      // color_hex
      params.push('#FFFFFF'); placeholders.push(`$${i++}`);

      // optional identifier
      if (kind === 'email' || kind === 'phone' || kind === 'handle') {
        params.push(idNorm); placeholders.push(`$${i++}`);
      }

      // Reorder cols to match placeholders count:
      // We constructed placeholders to match the base cols order + the optional column at the end,
      // so cols array already matches: interacted_code, first_seen_at, last_seen_at, ua, iphash, locale, tz, color_hex, [identifier col]
      const insertSql = `
        INSERT INTO ff_member (${cols.join(', ')})
        VALUES (${placeholders.join(', ')})
        ON CONFLICT DO NOTHING
      `;
      await client.query(insertSql, params);
    } catch (err) {
      console.warn('[member.insert] WARN', { message: err.message, code: err.code, detail: err.detail });
      // non-fatal
    }

    await client.query('COMMIT');

    /* 4) Build signup URL */
    const siteBase = process.env.PUBLIC_SITE_ORIGIN || 'https://fortifiedfantasy.com';
    const params = new URLSearchParams({ source: `ffint-${code}` });
    if (kind === 'email')  params.set('email',  idNorm);
    if (kind === 'phone')  params.set('phone',  idNorm);
    if (kind === 'handle') params.set('handle', idNorm);
    const signupUrl = `${siteBase}/signup?${params.toString()}`;

    /* 5) Cookies */
    try {
      res.cookie(
        'ff.pre.signup',
        encodeURIComponent(JSON.stringify({ firstIdentifier: idNorm, type: kind })),
        { httpOnly: false, sameSite: 'Lax', secure: !!req.secure, path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 }
      );
      res.cookie('ff-interacted', '1', {
        httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: 31536000000
      });
    } catch (err) {
      console.warn('[cookies] WARN', err.message);
    }

    return res.status(200).json({
      ok: true,
      invite_id: inviteId,
      interacted_code: code,
      signup_url: signupUrl
    });

  } catch (e) {
    // make sure aborted tx is cleared
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[identity.request-code] ERROR', {
      message: e.message, code: e.code, detail: e.detail
    });
    return res.status(500).json({
      ok:false,
      error:'server_error',
      code: e.code || null,
      detail: e.detail || null,
      message: e.message || null
    });
  } finally {
    client.release();
  }
});

module.exports = router;
