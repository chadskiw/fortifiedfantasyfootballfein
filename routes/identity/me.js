// src/routes/identity/me.js
// Mount with: app.use('/api/identity/me', require('./src/routes/identity/me'));
// Responsibilities:
// - If already logged in: validate session (IP/UA) and return member snapshot.
// - If NOT logged in but has ESPN cookies (SWID + espn_s2):
//     * upsert ff_espn_cred
//     * find-or-create member via ff_quickhitter (keyed by SWID)
//     * create ff_session (with ip_hash + user_agent)
//     * set ff_session_id, ff_member_id, ff_logged_in cookies
//     * fire ingest job
//     * return member snapshot

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const fetch = global.fetch || ((...a) => import('node-fetch').then(({default:f}) => f(...a)));

// ---- DB pool (supports either default or named export) ----
let db;
try { db = require('../../src/db/pool'); }
catch { db = require('../../src/db/pool'); }
const pool = (db && (db.pool || db));
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[identity/me] pg pool missing/invalid import');
}

// ---- cookie + env helpers ----
const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;
const COOKIE_BASE = {
  path: '/',
  sameSite: 'Lax',
  secure: true,       // assumes you terminate TLS at CDN/proxy
  httpOnly: true,
  maxAge: ONE_YEAR,
  // domain: process.env.FF_COOKIE_DOMAIN || undefined,
};

// ---- small utils ----
function sha256(s){ return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function clientUserAgent(req){ return String(req.headers['user-agent'] || '').slice(0,1024); }
function clientIP(req){
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xff || req.ip || '').replace(/^::ffff:/, '');
}
function norm(v){ return (v == null ? '' : String(v)).trim(); }
function normalizeSwid(raw) {
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(String(raw));
    const m = decoded.match(/\{?([0-9a-fA-F-]{36})\}?/);
    if (!m) return null;
    return `{${m[1].toUpperCase()}}`;
  } catch {
    return null;
  }
}
const MID_RE = /^[A-Z0-9]{8}$/;
function ensureMemberId(v) {
  const clean = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (MID_RE.test(clean)) return clean;
  const id = crypto.randomBytes(8).toString('base64').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase();
  return (id || 'ABCDEFGH').padEnd(8, 'X');
}

// ---- session helpers ----
async function ensureSessionRow({ memberId, req }) {
  const ua = clientUserAgent(req);
  const ip = clientIP(req);
  const ipHash = sha256(ip);
  const sid = crypto.randomUUID();

  // Try to insert a session row with fingerprint
  await pool.query(
    `
    INSERT INTO ff_session (session_id, member_id, ip_hash, user_agent, created_at, last_seen_at)
    VALUES ($1, $2, $3, $4, now(), now())
    ON CONFLICT (session_id) DO NOTHING
    `,
    [sid, memberId, ipHash, ua]
  );
  return sid;
}

function setFFSessionCookies(res, { sessionId, memberId }) {
  // httpOnly session id
  res.cookie('ff_session_id', sessionId, { ...COOKIE_BASE, httpOnly: true });

  // JS-readable helpers
  res.cookie('ff_member_id', memberId, { ...COOKIE_BASE, httpOnly: false });
  res.cookie('ff_logged_in', '1',       { ...COOKIE_BASE, httpOnly: false });
}

// ---- ESPN/linking helpers ----
async function upsertEspnCred({ swidBrace, s2 }) {
  // store swid as uuid (no braces, lowercase) in ff_espn_cred
  const swidUuid = swidBrace.slice(1, -1).toLowerCase();
  await pool.query(
    `
    INSERT INTO ff_espn_cred (swid, espn_s2, last_seen)
    VALUES ($1::uuid, NULLIF($2,''), now())
    ON CONFLICT (swid)
    DO UPDATE SET espn_s2 = COALESCE(EXCLUDED.espn_s2, ff_espn_cred.espn_s2),
                  last_seen = now()
    `,
    [swidUuid, s2 || null]
  );
}

async function findOrCreateMemberBySwid({ swidBrace }) {
  const swidUuid = swidBrace.slice(1, -1).toLowerCase();

  // 1) try to find a quickhitter row linking this SWID -> member
  const { rows } = await pool.query(
    `
    SELECT member_id, id AS quickhitter_id
      FROM ff_quickhitter
     WHERE swid = $1::uuid
     ORDER BY last_seen_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1
    `,
    [swidUuid]
  );

  if (rows.length) {
    // touch
    try {
      await pool.query(`UPDATE ff_quickhitter SET last_seen_at = now() WHERE swid = $1::uuid`, [swidUuid]);
    } catch {}
    return rows[0].member_id;
  }

  // 2) create a brand new member + link
  const memberId = ensureMemberId();
  await pool.query(
    `
    INSERT INTO ff_member (member_id, created_at, first_seen_at, last_seen_at, event_count)
    VALUES ($1, now(), now(), now(), 0)
    ON CONFLICT (member_id) DO NOTHING
    `,
    [memberId]
  );

  await pool.query(
    `
    INSERT INTO ff_quickhitter (member_id, quick_snap, swid, last_seen_at, created_at)
    VALUES ($1, $2, $3::uuid, now(), now())
    ON CONFLICT (member_id) DO NOTHING
    `,
    [memberId, swidBrace, swidUuid]
  );

  return memberId;
}

async function fireIngest(req, { swidBrace, s2, memberId }) {
  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    // include headers to satisfy any downstream “ensureCred” step
    fetch(`${origin}/api/platforms/espn/ingest/espn/fan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-espn-swid': swidBrace,
        'x-espn-s2':   s2 || '',
        'x-fein-key':  memberId
      },
      body: '{}'
    }).catch(() => {});
  } catch {}
}

// Optional CORS/preflight (kept same)
router.options('/', (_req, res) => res.sendStatus(204));

/**
 * FRAUD notifier hook (unchanged from your version)
 * - Wire this to NotificationAPI by setting env vars:
 *   NOTIFY_URL, NOTIFY_KEY, NOTIFY_TO
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
 * Load normalized member snapshot
 */
async function loadMemberSnapshot(memberId) {
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
  const { rows } = await pool.query(memQ, [memberId]);
  return rows[0] || null;
}

/**
 * GET /api/identity/me
 */
router.get('/', async (req, res) => {
  try {
    const c = req.cookies || {};
    const memberCookie  = norm(c.ff_member_id || c.ff_member);
    const sessionCookie = norm(c.ff_session_id || c.ff_session);
    const loggedFlag    = (c.ff_logged_in || '') === '1';

    // If we think we're logged in, validate the session
    if (memberCookie && sessionCookie && loggedFlag) {
      const ua = clientUserAgent(req);
      const ip = clientIP(req);
      const ipHash = sha256(ip);

      const sessQ = `
        SELECT session_id, member_id, ip_hash, user_agent
          FROM ff_session
         WHERE session_id = $1
           AND member_id  = $2
         LIMIT 1
      `;
      const sessRes = await pool.query(sessQ, [sessionCookie, memberCookie]);
      const sessRow = sessRes.rows[0];

      if (!sessRow) {
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

      // Happy path: touch last_seen_at and return snapshot
      try {
        await pool.query(`UPDATE ff_session SET last_seen_at = now() WHERE session_id = $1`, [sessRow.session_id]);
      } catch {}
      const m = await loadMemberSnapshot(memberCookie);
      return res.json(m ? {
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
      } : { ok: true, member_id: null });
    }

    // --- AUTO-LOGIN PATH: not logged in, but ESPN cookies exist ---
    const swidBrace = normalizeSwid(c.SWID || c.swid);
    const s2        = norm(c.espn_s2 || c.ESPN_S2);

    if (swidBrace && s2) {
      // 1) persist/refresh ESPN creds
      await upsertEspnCred({ swidBrace, s2 });

      // 2) find-or-create a member linked to this SWID
      const memberId = await findOrCreateMemberBySwid({ swidBrace });

      // 3) create session row with fingerprint + set cookies
      const sessionId = await ensureSessionRow({ memberId, req });
      setFFSessionCookies(res, { sessionId, memberId });

      // 4) fire ingest in the background
      fireIngest(req, { swidBrace, s2, memberId });

      // 5) return member snapshot (fresh)
      const m = await loadMemberSnapshot(memberId);
      return res.json(m ? {
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
      } : { ok: true, member_id: memberId });
    }

    // No valid FF session and no ESPN cookies → anonymous
    return res.json({ ok: true, member_id: null });
  } catch (err) {
    console.error('[identity/me] error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
