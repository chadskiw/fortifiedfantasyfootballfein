// routes/identity-api.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// 👇 reuse the pool created in server.js (avoids multiple connections)
const { pool } = require('../server');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE = /^\+?[0-9\-\s().]{7,}$/;

function normalizeIdentifier(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (EMAIL_RE.test(v)) return v.toLowerCase();
  if (PHONE_RE.test(v)) return '+' + v.replace(/[^\d]/g, '');
  return v;
}
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || 'ff-default-salt';
  return crypto.createHash('sha256').update(`${salt}|${ip || ''}`).digest('hex');
}
function firstLang(h=''){ return (h.split(',')[0] || '').trim() || null; }

router.options('/request-code', (req, res) => {
  const origin = req.headers.origin;
  if (origin) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary','Origin'); res.set('Access-Control-Allow-Credentials','true'); }
  res.set('Access-Control-Allow-Headers','content-type');
  res.set('Access-Control-Allow-Methods','POST,OPTIONS');
  res.sendStatus(204);
});

router.post('/request-code', async (req, res) => {
  try {
    if (!req.is('application/json')) {
      return res.status(415).json({ ok:false, error:'unsupported_media_type' });
    }

    const { identifier, tz, locale, utm_source, utm_medium, utm_campaign, landing_url } = req.body || {};
    const idNorm = normalizeIdentifier(identifier);
    if (!idNorm) return res.status(400).json({ ok:false, error:'bad_request', detail:'identifier required' });

    const code     = genCode();
    const source   = utm_source   ?? req.query.utm_source   ?? null;
    const medium   = utm_medium   ?? req.query.utm_medium   ?? null;
    const campaign = utm_campaign ?? req.query.utm_campaign ?? null;

    const landing  = landing_url || req.body?.landingUrl || req.get('referer') || null;
    const referer  = req.get('referer') || null;
    const ua       = req.get('user-agent') || null;
    const iphash   = hashIp(req.ip);
    const loc      = locale || firstLang(req.get('accept-language'));
    const timezone = tz || null;

    // Insert into YOUR columns only. Unspecified columns use defaults/nulls.
    const q = `
      INSERT INTO ff_invite
        (interacted_code, invited_at, source, medium, campaign, landing_url, referrer,
         user_agent, ip_hash, locale, tz, first_identifier)
      VALUES
        ($1, NOW(), $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11)
      RETURNING invite_id
    `;
    const vals = [code, source, medium, campaign, landing, referer, ua, iphash, loc, timezone, idNorm];
    const r = await pool.query(q, vals);

    // Cross-site cookie (lives on auth domain)
    res.cookie('ff-interacted', '1', { httpOnly:true, secure:true, sameSite:'none', path:'/', maxAge:31536000000 });

    return res.json({ ok:true, invite_id: r.rows[0].invite_id });
  } catch (e) {
    console.error('identity.request-code error:', e);
    // Return debuggable info so you can see it in the browser console
    return res.status(500).json({
      ok:false, error:'server_error',
      code: e.code || null,
      detail: e.detail || null,
      message: e.message || null
    });
  }
});

module.exports = router;
