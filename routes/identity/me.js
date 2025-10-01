// src/routes/identity/me.js
// Mount with: app.use('/api/identity/me', require('./src/routes/identity/me'));

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

// ---- DB pool (supports either default or named export) ----
let db;
try { db = require('../../src/db/pool'); }
catch { db = require('../../src/db/pool'); }
const pool = (db && (db.pool || db));
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[identity/me] pg pool missing/invalid import');
}

// ---- helpers ----
function sha256(s){ return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function clientUserAgent(req){ return String(req.headers['user-agent'] || '').slice(0,1024); }
function clientIP(req){
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xff || req.ip || '').replace(/^::ffff:/, '');
}

// Optional CORS/preflight
router.options('/', (_req, res) => res.sendStatus(204));

/**
 * FRAUD notifier hook
 * - Wire this to NotificationAPI by setting env vars:
 *   NOTIFY_URL  (e.g., https://notificationapi.com/api/send)
 *   NOTIFY_KEY  (API key)
 *   NOTIFY_TO   (defaults to fortifiedfantasy@gmail.com)
 */
async function notifyFraud(payload){
  const url = process.env.NOTIFY_URL;
  const key = process.env.NOTIFY_KEY;
  const to  = process.env.NOTIFY_TO || 'fortifiedfantasy@gmail.com';
  if (!url || !key) {
    console.warn('[identity/me] FRAUD (notification not configured):', payload);
    return;
  }
  try {
    await fetch(url, {
      method:'POST',
      headers:{ 'content-type':'application/json', 'authorization': `Bearer ${key}` },
      body: JSON.stringify({
        to,
        subject: 'FRAUD ALERT: Session fingerprint mismatch',
        text: JSON.stringify(payload, null, 2),
        type: 'FRAUD'
      })
    });
  } catch (e) {
    console.error('[identity/me] FRAUD notify failed', e);
  }
}

/**
 * GET /api/identity/me
 * Verifies auth by 3 cookies:
 *  - ff_member_id
 *  - ff_session_id
 *  - ff_logged_in === '1'
 * Then checks ff_session row and compares ip_hash + user_agent.
 * If mismatch => inserts ff_fraud_attempt and triggers FRAUD email.
 * If OK => returns normalized ff_member snapshot and touches last_seen_at.
 */
router.get('/', async (req, res) => {
  try {
    const c = req.cookies || {};
    const memberCookie  = (c.ff_member_id || c.ff_member || '').trim();
const sessionCookie = (c.ff_session_id || c.ff_session || '').trim();
    const loggedFlag    = (c.ff_logged_in || '') === '1';

    // If any of the 3 flags is missing, treat as not logged in.
    if (!memberCookie || !sessionCookie || !loggedFlag) {
      return res.json({ ok: true, member_id: null });
    }

    const ua = clientUserAgent(req);
    const ip = clientIP(req);
    const ipHash = sha256(ip);

    // Look up session row
    const sessQ = `
      SELECT session_id, member_id, ip_hash, user_agent, created_at, last_seen_at
        FROM ff_session
       WHERE session_id = $1
         AND member_id  = $2
       LIMIT 1
    `;
    const sessRes = await pool.query(sessQ, [sessionCookie, memberCookie]);
    const sessRow = sessRes.rows[0];

    if (!sessRow) {
      // Session not found for this member — fraud/invalid cookies.
      const fraud = {
        reason: 'session_not_found',
        member_id: memberCookie,
        cookie_session_id: sessionCookie,
        ip_hash_now: ipHash,
        user_agent_now: ua,
        headers_sample: {
          'user-agent': req.headers['user-agent'],
          'x-forwarded-for': req.headers['x-forwarded-for'] || null
        },
        at: new Date().toISOString()
      };
      // Insert attempt
      try {
        await pool.query(`
          INSERT INTO ff_fraud_attempt
            (member_id, session_id, reason, ip_hash_now, user_agent_now, headers_json, created_at)
          VALUES ($1,$2,$3,$4,$5,$6, now())
        `, [memberCookie, sessionCookie, fraud.reason, fraud.ip_hash_now, fraud.user_agent_now, JSON.stringify(fraud.headers_sample)]);
      } catch (e) { console.error('[identity/me] insert fraud (no session)', e); }
      await notifyFraud(fraud);
      return res.status(401).json({ ok:false, error:'fraud', message:'Session invalid.' });
    }

    // Compare fingerprint
    const uaMatches = String(sessRow.user_agent || '') === ua;
    const ipMatches = String(sessRow.ip_hash || '') === ipHash;

    if (!uaMatches || !ipMatches) {
      const fraud = {
        reason: 'fingerprint_mismatch',
        member_id: sessRow.member_id,
        session_id: sessRow.session_id,
        ip_hash_now: ipHash,
        ip_hash_db: sessRow.ip_hash,
        user_agent_now: ua,
        user_agent_db: sessRow.user_agent,
        headers_sample: {
          'user-agent': req.headers['user-agent'],
          'x-forwarded-for': req.headers['x-forwarded-for'] || null
        },
        at: new Date().toISOString()
      };
      try {
        await pool.query(`
          INSERT INTO ff_fraud_attempt
            (member_id, session_id, reason, ip_hash_now, ip_hash_db, user_agent_now, user_agent_db, headers_json, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
        `, [
          sessRow.member_id, sessRow.session_id, fraud.reason,
          fraud.ip_hash_now, fraud.ip_hash_db, fraud.user_agent_now, fraud.user_agent_db,
          JSON.stringify(fraud.headers_sample)
        ]);
      } catch (e) { console.error('[identity/me] insert fraud (mismatch)', e); }
      await notifyFraud(fraud);
      return res.status(401).json({ ok:false, error:'fraud', message:'Session fingerprint mismatch.' });
    }

    // Fingerprint OK → touch last_seen_at
    try {
      await pool.query(`UPDATE ff_session SET last_seen_at = now() WHERE session_id = $1`, [sessRow.session_id]);
    } catch (e) { /* non-fatal */ }

    // Load ff_member snapshot
    const memQ = `
      SELECT
        member_id,
        handle,
        color_hex,
        email,
        phone_e164                                     AS phone,
        email_verified_at,
        phone_verified_at,
        image_key,
        event_count,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at
      FROM ff_member
      WHERE deleted_at IS NULL
        AND member_id = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(memQ, [memberCookie]);

    if (!rows.length) {
      return res.json({ ok: true, member_id: null });
    }

    const m = rows[0];

    res.json({
      ok: true,
      member_id: m.member_id,
      handle: m.handle || null,
      color_hex: m.color_hex || null,
      email: m.email || null,
      phone: m.phone || null,
      email_verified_at: m.email_verified_at || null,
      phone_verified_at: m.phone_verified_at || null,
      email_verified: !!m.email_verified_at,
      phone_verified: !!m.phone_verified_at,
      image_key: m.image_key || null,
      event_count: m.event_count ?? 0,
      first_seen_at: m.first_seen_at || null,
      last_seen_at: m.last_seen_at || null,
      created_at: m.created_at || null,
      updated_at: m.updated_at || null,
    });
  } catch (err) {
    console.error('[identity/me] error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
