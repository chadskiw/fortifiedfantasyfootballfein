// routes/identity-api/request-code.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Reuse the shared pool (export { pool } from server.js)
const { pool } = require('../server');

/* ---------- helpers ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE = /^\+?[0-9\-\s().]{7,}$/;

function normalizeIdentifier(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (EMAIL_RE.test(v)) return v.toLowerCase();
  if (PHONE_RE.test(v)) return '+' + v.replace(/[^\d]/g, '');
  return v; // treat as handle/username
}

// unambiguous 8-char code (no 0/O or 1/I)
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
function firstLang(h=''){ return (h.split(',')[0] || '').trim() || null; }

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
  if (!idNorm) return res.status(400).json({ ok:false, error:'bad_request', detail:'identifier required' });

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
  const clientIp = req.headers['cf-connecting-ip'] || req.ip; // set app.set('trust proxy', true)
  const iphash   = hashIp(clientIp);
  const loc      = locale || firstLang(req.get('accept-language'));
  const timezone = tz || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) ff_invite insert
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
      throw err;
    }

    // 2) tag source "…:ffint-CODE" (non-fatal)
    try {
      await client.query(
        `UPDATE ff_invite
           SET source = COALESCE(NULLIF(source,''), 'web') || ':ffint-' || $1
         WHERE invite_id = $2`,
        [code, inviteId]
      );
    } catch (err) {
      console.warn('[invite.tag] WARN', { message: err.message, code: err.code, detail: err.detail });
    }

    // 3) opportunistic ff_member upsert in two simple steps:
    // 3a) base insert (no dynamic columns)
    try {
      await client.query(
        `INSERT INTO ff_member
           (interacted_code, first_seen_at, last_seen_at, user_agent, ip_hash, locale, tz, color_hex)
         VALUES
           ($1, NOW(), NOW(), $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [code, ua || null, iphash, loc || null, timezone || null, '#FFFFFF']
      );
    } catch (err) {
      console.warn('[member.insert] WARN', { message: err.message, code: err.code, detail: err.detail });
    }

    // 3b) set the identifier column if we have one (only if empty)
    try {
      if (kind === 'email') {
        await client.query(
          `UPDATE ff_member
             SET email = $2
           WHERE interacted_code = $1
             AND (email IS NULL OR email = '')`,
          [code, idNorm]
        );
      } else if (kind === 'phone') {
        await client.query(
          `UPDATE ff_member
             SET phone_e164 = $2
           WHERE interacted_code = $1
             AND (phone_e164 IS NULL OR phone_e164 = '')`,
          [code, idNorm]
        );
      } else {
        await client.query(
          `UPDATE ff_member
             SET username = $2
           WHERE interacted_code = $1
             AND (username IS NULL OR username = '')`,
          [code, idNorm]
        );
      }
    } catch (err) {
      console.warn('[member.update.id] WARN', { message: err.message, code: err.code, detail: err.detail });
    }

    await client.query('COMMIT');

    // 4) build signup URL
    const siteBase = process.env.PUBLIC_SITE_ORIGIN || 'https://fortifiedfantasy.com';
    const qs = new URLSearchParams({ source: `ffint-${code}` });
    if (kind === 'email')  qs.set('email',  idNorm);
    if (kind === 'phone')  qs.set('phone',  idNorm);
    if (kind === 'handle') qs.set('handle', idNorm);
    const signup_url = `${siteBase}/signup?${qs.toString()}`;

    // 5) cookies
    try {
      res.cookie(
        'ff.pre.signup',
        encodeURIComponent(JSON.stringify({ firstIdentifier: idNorm, type: kind })),
        { httpOnly: false, sameSite: 'Lax', secure: !!req.secure, path: '/', maxAge: 7*24*60*60*1000 }
      );
      res.cookie('ff-interacted', '1', {
        httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: 31536000000
      });
    } catch (err) {
      console.warn('[cookies] WARN', err.message);
    }

    return res.status(200).json({ ok:true, invite_id: inviteId, interacted_code: code, signup_url });

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[identity.request-code] ERROR', { message: e.message, code: e.code, detail: e.detail });
    return res.status(500).json({
      ok:false, error:'server_error',
      code: e.code || null, detail: e.detail || null, message: e.message || null
    });
  } finally {
    client.release();
  }
});

module.exports = router;
