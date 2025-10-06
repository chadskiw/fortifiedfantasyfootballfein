// routes/espn.js
// End-to-end ESPN login/link flow:
// - GET  /api/espn/login            (sets SWID/S2 cookies, persists cred, links QH, sets ff_* cookies, fires ingest, redirects)
// - GET  /api/espn/authcheck        (does server see ESPN auth?)
// - POST /api/espn/link-via-cookie  (persist S2 from cookies, link if possible, set ff_* cookies)
// - POST /api/espn/link             (bind current SWID to explicit member_id)

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const fetch   = global.fetch || ((...a) => import('node-fetch').then(({default:f}) => f(...a)));

let db = require('../src/db/pool');
let pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[pg] pool.query not available — check require path/export');
}

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'Lax',
  secure  : true,
  path    : '/',
  // domain: '.fortifiedfantasy.com', // uncomment if you need subdomain sharing
};

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
const norm = v => (v == null ? '' : String(v)).trim();

const MID_RE = /^[A-Z0-9]{8}$/;
function ensureMemberId(v) {
  const clean = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (MID_RE.test(clean)) return clean;
  const id = crypto.randomBytes(8).toString('base64').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase();
  return (id || 'ABCDEFGH').padEnd(8, 'X');
}
function makeSid() {
  return crypto.randomBytes(24).toString('base64url');
}
function setAuthCookies(res, { memberId, sid }) {
  res.cookie('ff_member', memberId, COOKIE_OPTS);
  res.cookie('ff_sid', sid, COOKIE_OPTS);
}

// --- tiny helpers ---------------------------------------------------
async function upsertEspnCred({ swidBrace, s2 }) {
  const swidUuid = swidBrace.slice(1, -1).toLowerCase();
  await pool.query(
    `
    INSERT INTO ff_espn_cred (swid, espn_s2, last_seen)
    VALUES ($1::uuid, NULLIF($2,'') , NOW())
    ON CONFLICT (swid)
    DO UPDATE SET espn_s2 = COALESCE(EXCLUDED.espn_s2, ff_espn_cred.espn_s2), last_seen = NOW()
    `,
    [swidUuid, s2 || null]
  );
}

async function linkFromSwid({ swidBrace }) {
  const swidUuid = swidBrace.slice(1, -1).toLowerCase();
  const { rows } = await pool.query(
    `
    SELECT * FROM ff_quickhitter
     WHERE quick_snap = $1
        OR swid = $2::uuid
     ORDER BY last_seen DESC NULLS LAST, created_at DESC
     LIMIT 1
    `,
    [swidBrace, swidUuid]
  );
  const row = rows[0];
  if (!row) return { step: 'unlinked' };

  // backfill swid uuid
  if (!row.swid) {
    await pool.query(`UPDATE ff_quickhitter SET swid=$1::uuid, last_seen__at=NOW() WHERE id=$2`, [swidUuid, row.id]);
  }

  let memberId = norm(row.member_id);
  if (!memberId) {
    memberId = ensureMemberId(row.member_id);
    await pool.query(`UPDATE ff_quickhitter SET member_id=$1, last_seen_at=NOW() WHERE id=$2`, [memberId, row.id]);
  }

  return { step: 'linked', memberId };
}

// fire-and-forget fan ingest (won’t block the response)
async function fireIngest(req) {
  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    await fetch(`${origin}/api/platforms/espn/ingest/espn/fan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // cookies are HttpOnly and already set on the domain; no need to forward headers here
    }).catch(() => {});
  } catch (_) {}
}

// ===================================================================
// GET /api/espn/authcheck → { ok:true, authed:boolean }
// ===================================================================
router.get('/authcheck', (req, res) => {
  const swid = normalizeSwid(req.cookies?.SWID);
  const s2   = norm(req.cookies?.espn_s2);
  res.json({ ok: true, authed: !!(swid && s2) });
});

// ===================================================================
// GET /api/espn/login?swid={...}&s2=...&to=/fein/index.html?season=2025
// Sets SWID/espn_s2 cookies, persists cred, links member, sets ff_*,
// fires ingest, then redirects to ?to=...
// ===================================================================
router.get('/login', async (req, res) => {
  try {
    const swidBrace = normalizeSwid(req.query.swid);
    if (!swidBrace) return res.status(400).json({ ok: false, error: 'bad_swid' });

    const s2      = req.query.s2 && String(req.query.s2).trim();
    const toParam = req.query.to && String(req.query.to).trim();
    const redirectTo = (() => {
      try { return new URL(toParam || `/fein/?season=${new Date().getUTCFullYear()}`, `${req.protocol}://${req.get('host')}`).toString(); }
      catch { return `/fein/?season=${new Date().getUTCFullYear()}`; }
    })();

    // 1) set ESPN cookies on our domain
    res.cookie('SWID', encodeURIComponent(swidBrace), COOKIE_OPTS);
    if (s2) res.cookie('espn_s2', s2, COOKIE_OPTS);

    // 2) persist/refresh creds server-side
    await upsertEspnCred({ swidBrace, s2 });

    // 3) attempt to link SWID → quickhitter → member
    const link = await linkFromSwid({ swidBrace });
    if (link.step === 'linked') {
      const sid = makeSid();
      setAuthCookies(res, { memberId: link.memberId, sid });

      // 4) kick ingest in background
      fireIngest(req);
    }

    // 5) redirect to requested page
    return res.redirect(302, redirectTo);
  } catch (e) {
    console.error('[espn.login]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================================================================
// POST /api/espn/link-via-cookie → { ok:true, step:'linked'|'unlinked', member_id? }
// Reads SWID/S2 from HttpOnly cookies; persists and links; sets ff_*; fires ingest.
// ===================================================================
router.post('/link-via-cookie', async (req, res) => {
  try {
    const swidBrace = normalizeSwid(req.cookies?.SWID);
    const s2 = norm(req.cookies?.espn_s2);
    if (!swidBrace) return res.json({ ok: true, step: 'unlinked' });

    await upsertEspnCred({ swidBrace, s2 });

    const link = await linkFromSwid({ swidBrace });
    if (link.step === 'linked') {
      const sid = makeSid();
      setAuthCookies(res, { memberId: link.memberId, sid });
      fireIngest(req);
      return res.json({ ok: true, step: 'linked', member_id: link.memberId });
    }
    return res.json({ ok: true, step: 'unlinked' });
  } catch (e) {
    console.error('[espn.link-via-cookie]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================================================================
// POST /api/espn/link { memberId }
// Bind current SWID to a specific member_id, then set ff_* and ingest.
// ===================================================================
router.post('/link', async (req, res) => {
  try {
    const swidBrace = normalizeSwid(req.cookies?.SWID);
    if (!swidBrace) return res.status(400).json({ ok: false, error: 'no_swid' });
    const swidUuid = swidBrace.slice(1, -1).toLowerCase();

    const memberId = ensureMemberId(req.body?.memberId);
    if (!memberId) return res.status(400).json({ ok: false, error: 'bad_member' });

    // update/insert quickhitter row for that member (preserve existing handle/color/etc)
    await pool.query(
      `
      INSERT INTO ff_quickhitter (member_id, quick_snap, swid, last_seen_at, created_at)
      VALUES ($1, $2, $3::uuid, NOW(), NOW())
      ON CONFLICT (member_id)
      DO UPDATE SET quick_snap = EXCLUDED.quick_snap,
                    swid       = EXCLUDED.swid,
                    last_seen_at = NOW()
      `,
      [memberId, swidBrace, swidUuid]
    );

    const sid = makeSid();
    setAuthCookies(res, { memberId, sid });
    fireIngest(req);

    return res.json({ ok: true, linked: true, member_id: memberId });
  } catch (e) {
    console.error('[espn.link]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
