// routes/session.js
const express = require('express');
const crypto  = require('crypto');

const db   = require('../src/db/pool');
const pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[session] pg pool missing');
}

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

/* ---------- helpers ---------- */
const MEMBER_TTL_MS  = 365 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30  * 24 * 60 * 60 * 1000;

function secureCookies() { return process.env.NODE_ENV === 'production'; }
function cookieOpts(maxAgeMs) {
  return { httpOnly:true, sameSite:'Lax', secure:secureCookies(), path:'/', maxAge:maxAgeMs };
}
function clientCookieOpts(maxAgeMs) {
  return { httpOnly:false, sameSite:'Lax', secure:secureCookies(), path:'/', maxAge:maxAgeMs };
}
function ipHash(req) {
  const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
  return crypto.createHash('sha256').update(ip).digest('hex');
}
function newSid() { return crypto.randomUUID().replace(/-/g,''); }

async function ensureTables() {
  // Make ff_session compatible with code that uses (session_id, created_at, last_seen_at, ...)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_session (
      session_id  TEXT PRIMARY KEY,
      member_id   TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_hash     TEXT,
      user_agent  TEXT
    );
    CREATE INDEX IF NOT EXISTS ff_session_member_idx ON ff_session(member_id);
  `);
}

async function createSession(memberId, req, ttlDays = 30) {
  await ensureTables();
  const sid = newSid();
  await pool.query(
    `INSERT INTO ff_session (session_id, member_id, created_at, last_seen_at, ip_hash, user_agent)
     VALUES ($1,$2, NOW(), NOW(), $3, $4)
     ON CONFLICT (session_id) DO NOTHING`,
    [sid, memberId, ipHash(req), String(req.headers['user-agent']||'').slice(0,400)]
  );
  return sid;
}

async function destroySession(sessionId) {
  if (!sessionId) return;
  await pool.query(`DELETE FROM ff_session WHERE session_id=$1`, [sessionId]);
}

async function loadSession(sessionId) {
  if (!sessionId) return null;
  const { rows } = await pool.query(`
    SELECT s.session_id, s.member_id, s.created_at, s.last_seen_at,
           m.handle, m.email, m.phone_e164, m.color_hex,
           m.adj1, m.adj2, m.noun,
           (m.email_verified_at IS NOT NULL) AS email_is_verified,
           (m.phone_verified_at IS NOT NULL) AS phone_is_verified
      FROM ff_session s
 LEFT JOIN ff_member m ON m.member_id = s.member_id
     WHERE s.session_id=$1
     LIMIT 1
  `,[sessionId]);
  return rows[0] || null;
}

async function touchSession(sessionId) {
  if (!sessionId) return;
  await pool.query(`UPDATE ff_session SET last_seen_at=NOW() WHERE session_id=$1`, [sessionId]);
}

function setAuthCookies(res, memberId, sid) {
  // Long-lived member cookies (legacy + client-readable)
  res.cookie('ff_member', memberId, clientCookieOpts(MEMBER_TTL_MS));
  res.cookie('ff_member_id', memberId, cookieOpts(MEMBER_TTL_MS));

  // Session cookies the platform expects
  res.cookie('ff_sid', sid, cookieOpts(SESSION_TTL_MS));              // HttpOnly trusted session
  res.cookie('ff_session_id', sid, cookieOpts(SESSION_TTL_MS));       // legacy alias, HttpOnly
  res.cookie('ff_session', sid, clientCookieOpts(SESSION_TTL_MS));    // readable alias for FE
  res.cookie('ff_logged_in', '1', clientCookieOpts(SESSION_TTL_MS));  // boolean flag legacy flows use
}

function clearAuthCookies(res) {
  res.cookie('ff_sid','',          cookieOpts(0));
  res.cookie('ff_session_id','',   cookieOpts(0));
  res.cookie('ff_session','',      clientCookieOpts(0));
  res.cookie('ff_member','',       clientCookieOpts(0));
  res.cookie('ff_member_id','',    cookieOpts(0));
  res.cookie('ff_logged_in','',    clientCookieOpts(0));
}

/* ---------- routes ---------- */
// GET /api/session/bootstrap  → soft status (never 401)
router.get('/bootstrap', async (req, res) => {
  try {
    const sess = await getSession(req.cookies?.ff_sid || null);
    res.set('Cache-Control','no-store');
    res.json({ ok: true, authenticated: !!sess, member_id: sess?.member_id || null });
  } catch (e) {
    res.set('Cache-Control','no-store');
    res.json({ ok: true, authenticated: false });
  }
});

// Soft, no-error boot probe used by FE
// GET /api/session/cred → 200 always
router.get('/cred', async (req, res) => {
  try {
    const sid = req.cookies?.ff_sid || '';
    const sess = await loadSession(sid);
    if (sess) await touchSession(sid);

    res.set('Cache-Control','no-store');

    // Optional: espn link flag
    let espn_linked = false;
    if (sess?.member_id) {
      const r = await pool.query(
        `SELECT 1 FROM ff_member_platform WHERE member_id=$1 AND platform='espn' LIMIT 1`,
        [sess.member_id]
      );
      espn_linked = r.rowCount > 0;
    }

    return res.json({
      ok: true,
      logged_in: !!sess,
      member_id: sess?.member_id || null,
      member: sess ? {
        member_id: sess.member_id,
        handle:    sess.handle || null,
        email:     sess.email || null,
        phone:     sess.phone_e164 || null,
        color_hex: sess.color_hex || null,
        adj1: sess.adj1||null, adj2: sess.adj2||null, noun: sess.noun||null,
        email_is_verified: !!sess.email_is_verified,
        phone_is_verified: !!sess.phone_is_verified
      } : null,
      espn_linked
    });
  } catch (e) {
    console.error('[session.cred]', e);
    res.status(200).json({ ok:true, logged_in:false });
  }
});

// Strict variant; still returns 200 to keep console tidy
router.get('/whoami', async (req,res) => {
  try {
    const sid  = req.cookies?.ff_sid || '';
    const sess = await loadSession(sid);
    if (sess) await touchSession(sid);
    res.set('Cache-Control','no-store');
    return res.json({ ok:true, logged_in:!!sess, member_id: sess?.member_id || null });
  } catch(e) {
    console.error('[whoami]', e);
    res.status(200).json({ ok:true, logged_in:false });
  }
});

// POST /api/session/logout  (alias for /clear)
router.post('/logout', async (req,res) => {
  try { await destroySession(req.cookies?.ff_sid||null); } catch {}
  clearAuthCookies(res);
  res.set('Cache-Control','no-store');
  res.json({ ok:true, logged_out:true });
});
router.post('/clear', async (req,res) => {
  try { await destroySession(req.cookies?.ff_sid||null); } catch {}
  clearAuthCookies(res);
  res.json({ ok:true });
});

router.post('/ghost-login', async (req, res) => {
  try {
    const handleRaw = (req.body?.handle || '').trim();
    if (!handleRaw) {
      return res.status(400).json({ ok: false, error: 'missing_handle' });
    }

    const handle = handleRaw.toLowerCase();
    const publicHandle = (process.env.PUBLIC_VIEWER_HANDLE || 'PUBGHOST').toLowerCase();
    if (handle !== publicHandle) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const { rows } = await pool.query(
      `SELECT member_id FROM ff_member WHERE LOWER(handle) = LOWER($1) LIMIT 1`,
      [handleRaw]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'public_viewer_missing' });
    }

    const memberId = rows[0].member_id;
    const sid = await createSession(memberId, req, 7);
    setAuthCookies(res, memberId, sid);
    res.cookie('ff_logged_in', '1', clientCookieOpts(30 * 24 * 60 * 60 * 1000));

    return res.json({ ok: true, member_id: memberId });
  } catch (err) {
    console.error('[session.ghost-login]', err);
    res.status(500).json({ ok: false, error: 'ghost_login_failed' });
  }
});

// POST /api/session/login-by-descriptors { member_id, adj1, adj2, noun }
router.post('/login-by-descriptors', async (req,res) => {
  try {
    const { member_id, adj1, adj2, noun } = req.body || {};
    if (!member_id || !noun) return res.status(422).json({ ok:false, error:'missing_fields' });

    const { rows } = await pool.query(`
      SELECT 1 FROM ff_member
       WHERE member_id=$1
         AND LOWER(noun)=LOWER($2)
         AND ( LOWER(adj1)=LOWER($3) OR LOWER(adj2)=LOWER($3) )
       LIMIT 1
    `,[member_id, noun, (adj1||adj2||'')]);

    if (!rows[0]) return res.json({ ok:false, error:'descriptor_mismatch' });

    const sid = await createSession(member_id, req, 30);
    setAuthCookies(res, member_id, sid);
    return res.json({ ok:true, member_id });
  } catch(e){
    console.error('[login-by-descriptors]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

// POST /api/session/validate-cookies { kind:'email'|'phone', value }
router.post('/validate-cookies', async (req,res) => {
  try {
    const { kind, value } = req.body || {};
    if (!kind || !value) return res.status(422).json({ ok:false, error:'missing_fields' });

    const sid0 = req.cookies?.ff_sid || '';
    const sess = await loadSession(sid0);
    if (sess) {
      const owns =
        (kind==='email' && sess.email && sess.email.toLowerCase()===String(value).toLowerCase()) ||
        (kind==='phone' && sess.phone_e164 && sess.phone_e164===String(value));
      if (owns) return res.json({ ok:true, member_id:sess.member_id });
    }

    const col = (kind==='email') ? 'email' : 'phone_e164';
    const ver = (kind==='email') ? 'email_verified_at IS NOT NULL' : 'phone_verified_at IS NOT NULL';
    const { rows } = await pool.query(
      `SELECT member_id FROM ff_member WHERE ${col}=$1 AND ${ver} LIMIT 2`,
      [String(value)]
    );

    if (rows.length === 1) {
      const member_id = rows[0].member_id;
      const sid = await createSession(member_id, req, 30);
      setAuthCookies(res, member_id, sid);
      return res.json({ ok:true, member_id });
    }
    return res.json({ ok:false });
  } catch(e){
    console.error('[validate-cookies]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

module.exports = router;
