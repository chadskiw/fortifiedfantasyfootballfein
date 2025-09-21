// src/routes/verify.js
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
// If you already have these helpers somewhere else, import them instead of redefining.

const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
// ===== invite helper (inline for now; move to /src/lib/invite.js later) =====
const INVITE_COOKIE = 'ff_interacted';
function getLocale(req){ const h = String(req.headers['accept-language'] || ''); return h.split(',')[0] || null; }
function getTz(req){ return String(req.headers['x-ff-tz'] || '') || null; }

function makeInteractedCode(){
  return crypto.randomBytes(6).toString('base64url').slice(0,8).toUpperCase();
}

async function upsertInviteForRequest(req, res){
  let code = (req.cookies?.[INVITE_COOKIE] || '').trim();
  if (!code) code = makeInteractedCode();

  const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
  const landingUrl = String(req.headers['x-ff-landing'] || req.originalUrl || req.url || '');
  const referrer   = String(req.get('referer') || '');
  const ua         = String(req.get('user-agent') || '');
  const locale     = getLocale(req);
  const tz         = getTz(req);

  const { rows } = await pool.query(
    `INSERT INTO ff_invite (interacted_code, invited_at, source, medium, campaign, landing_url, referrer, user_agent, ip_hash, locale, tz)
     VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (interacted_code) DO UPDATE
       SET landing_url = COALESCE(ff_invite.landing_url, EXCLUDED.landing_url),
           referrer    = COALESCE(ff_invite.referrer,    EXCLUDED.referrer),
           user_agent  = COALESCE(ff_invite.user_agent,  EXCLUDED.user_agent),
           ip_hash     = COALESCE(ff_invite.ip_hash,     EXCLUDED.ip_hash),
           locale      = COALESCE(ff_invite.locale,      EXCLUDED.locale),
           tz          = COALESCE(ff_invite.tz,          EXCLUDED.tz)
     RETURNING invite_id, interacted_code`,
    [
      code,
      req.query.source || null,
      req.query.medium || null,
      req.query.campaign || null,
      landingUrl || null,
      referrer || null,
      ua || null,
      ipHash || null,
      locale || null,
      tz || null,
    ]
  );

  const invite = rows[0];
  if (!req.cookies?.[INVITE_COOKIE]) {
    res.cookie(INVITE_COOKIE, invite.interacted_code, {
      httpOnly: true, secure: true, sameSite: 'Lax',
      maxAge: 1000 * 60 * 60 * 24 * 365
    });
  }
  return invite;
}

// ===== identifier + code helpers =====
const isEmail = (x='') => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(x).trim());
const isPhone = (x='') => /^\+?[0-9][0-9\s\-().]{5,}$/.test(String(x).trim());
function normalizeIdentifier(kind, value){
  const v = String(value || '').trim();
  if (kind === 'email' && isEmail(v)) return { kind:'email', value:v };
  if (kind === 'phone') {
    let cleaned = v.replace(/[^\d+]/g, '');
    if (!cleaned.startsWith('+') && cleaned.length === 10) cleaned = '+1' + cleaned;
    if (/^\+\d{7,15}$/.test(cleaned)) return { kind:'phone', value:cleaned };
  }
  return { kind:null, value:null };
}
function genCode(){ return crypto.randomInt(0, 1_000_000).toString().padStart(6,'0'); }
// --- notifier (NotificationAPI first, then fallbacks; never throws) ---
let notifInited = false, notifReady = false, notificationapi = null;
function initNotificationAPI() {
  if (notifInited) return notifReady;
  notifInited = true;
  try {
    const clientId = process.env.NOTIFICATIONAPI_CLIENT_ID;
    const clientSecret = process.env.NOTIFICATIONAPI_CLIENT_SECRET;
    if (clientId && clientSecret) {
      notificationapi = require('notificationapi-node-server-sdk').default;
      notificationapi.init(clientId, clientSecret);
      notifReady = true;
      console.log('[notify] SDK initialized');
    } else {
      console.log('[notify] SDK not available; missing env credentials');
    }
  } catch (e) {
    console.log('[notify] SDK not initialized:', e?.message || e);
    notifReady = false;
  }
  return notifReady;
}

async function sendViaNotificationAPI({ identifierKind, identifierValue, code }) {
  try {
    const ok = initNotificationAPI();
    if (!ok) return false;
    const user = { id: identifierValue };
    if (identifierKind === 'email') user.email = identifierValue;
    if (identifierKind === 'phone') user.phone = identifierValue;
    await notificationapi.send({
      notificationId: process.env.NOTIFICATIONAPI_TEMPLATE_ID || 'login-code',
      user,
      mergeTags: { code }
    });
    return true;
  } catch (e) {
    console.warn('[notify] send failed:', e?.message || e);
    return false;
  }
}

async function sendViaFallbackProviders({ identifierKind, identifierValue, code }) {
  try {
    if (identifierKind === 'email') {
      const haveSendgrid = !!process.env.SENDGRID_API_KEY;
      const haveSmtp     = !!process.env.SMTP_HOST;
      if (!haveSendgrid && !haveSmtp) {
        console.log(`[MAIL:NOOP] to=${identifierValue} code=${code}`);
        return true;
      }
      const nodemailer = require('nodemailer');
      let transporter;
      if (haveSendgrid) {
        const sgTransport = require('nodemailer-sendgrid').default;
        transporter = nodemailer.createTransport(sgTransport({ apiKey: process.env.SENDGRID_API_KEY }));
      } else {
        transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: false,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
      }
      await transporter.sendMail({
        from: process.env.MAIL_FROM || 'Fortified Fantasy <no-reply@fortifiedfantasy.com>',
        to: identifierValue,
        subject: 'Your Fortified Fantasy sign-in code',
        text: `Your code is: ${code} (valid for 10 minutes)`,
      });
      return true;
    }
    if (identifierKind === 'phone') {
      const haveTwilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
      if (!haveTwilio) {
        console.log(`[SMS:NOOP] to=${identifierValue} code=${code}`);
        return true;
      }
      const twilio = require('twilio')(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
      await twilio.messages.create({
        to: identifierValue,
        from: process.env.TWILIO_FROM,
        body: `Fortified Fantasy code: ${code}`,
      });
      return true;
    }
  } catch (e) {
    console.warn('[fallback send] failed:', e?.message || e);
  }
  return false;
}

async function sendCode({ identifierKind, identifierValue, code }) {
  const viaNotif = await sendViaNotificationAPI({ identifierKind, identifierValue, code });
  if (viaNotif) return;
  await sendViaFallbackProviders({ identifierKind, identifierValue, code });
}

// ===== /verify/start (server generates & sends code; ties to invite) =====
router.post('/verify/start', async (req, res) => {
  try {
    const { kind: rawKind, value: rawValue } = req.body || {};
    const { kind, value } = normalizeIdentifier(rawKind, rawValue);
    if (!kind || !value) return res.status(422).json({ ok:false, error:'invalid_identifier' });

    const invite = await upsertInviteForRequest(req, res);
    const code = genCode();

    await pool.query(
      `INSERT INTO ff_identity_requests
        (identifier_kind, identifier_value, code, expires_at, invite_id, ip_hash)
       VALUES ($1,$2,$3, now() + interval '10 minutes', $4, $5)`,
      [
        kind,
        value,
        code,
        invite?.invite_id || null,
        crypto.createHash('sha256').update(String(req.headers['cf-connecting-ip'] || req.ip || '')).digest('hex'),
      ]
    );

    await pool.query(
      `UPDATE ff_invite SET first_identifier = COALESCE(first_identifier, $1) WHERE invite_id = $2`,
      [value, invite?.invite_id || null]
    );

await sendCode({ identifierKind: kind, identifierValue: value, code });


    res.json({ ok:true, sent:true, invite_id: invite?.invite_id || null });
  } catch (e) {
    console.error('[verify/start]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// ===== /verify/confirm =====
router.post('/verify/confirm', async (req, res) => {
  try {
    const { kind: rawKind, value: rawValue, code } = req.body || {};
    const { kind, value } = normalizeIdentifier(rawKind, rawValue);
    if (!kind || !value || !code) return res.status(422).json({ ok:false, error:'bad_request' });

    const { rows } = await pool.query(
      `SELECT id, expires_at, used_at, invite_id
         FROM ff_identity_requests
        WHERE identifier_kind=$1 AND identifier_value=$2 AND code=$3
        ORDER BY id DESC
        LIMIT 1`,
      [kind, value, code]
    );

    const hit = rows[0];
    if (!hit) return res.status(404).json({ ok:false, error:'not_found' });
    if (hit.used_at) return res.status(409).json({ ok:false, error:'already_used' });
    if (new Date(hit.expires_at) < new Date()) return res.status(410).json({ ok:false, error:'expired' });

    await pool.query(`UPDATE ff_identity_requests SET used_at = now() WHERE id=$1`, [hit.id]);

    const memberId = req.session?.member_id || null;
    await pool.query(
      `UPDATE ff_invite
          SET joined_at = COALESCE(joined_at, now()),
              member_id = COALESCE(member_id, $1),
              first_identifier = COALESCE(first_identifier, $2)
        WHERE invite_id = $3`,
      [memberId, value, hit.invite_id]
    );

    res.json({ ok:true, verified:true, invite_id: hit.invite_id || null });
  } catch (e) {
    console.error('[verify/confirm]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
