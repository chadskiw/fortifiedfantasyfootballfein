// routes/espn.js
// End-to-end ESPN login/link flow + asset shims + consistent app cookies.
//
// What this provides:
// • GET  /api/espn/login?swid={...}&s2=...&to=/fein/...  → sets ESPN cookies, links member, sets ff cookies, fires ingest, redirects
// • GET  /api/espn/authcheck                         → { ok, authed } (do we have SWID & espn_s2 cookies?)
// • GET  /api/espn/cred                              → { ok, swid, has_s2 }
// • GET  /api/platforms/espn/link-status             → { ok, linked } (based on ff_member cookie)
// • POST /api/platforms/espn/link-via-cookie         → link using SWID/S2 already on domain; sets ff cookies; ingests
// • POST /api/platforms/espn/link                    → bind current SWID to provided memberId; sets ff cookies; ingests
// • POST /api/platforms/espn/ingest/espn/fan         → 204 (accepts ingest trigger)
// • Asset shims for various CSS/JS that used to 404

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const fetch   = global.fetch || ((...a) => import('node-fetch').then(({ default: f }) => f(...a)));

const poolMod = require('../src/db/pool');
const pool = poolMod.pool || poolMod;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[pg] pool.query not available — check require path/export');
}

// Centralized cookie helpers (you shared this as ../src/lib/cookies.js)
const cookies = require('../src/lib/cookies');

// -----------------------------------------------------------------------------
// Cookie options for the raw ESPN cookies we mirror onto our domain.
// NOTE: app (ff_*) cookies are set via ../src/lib/cookies.js
// -----------------------------------------------------------------------------
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure  : true,
  path    : '/',
  // If you need subdomain sharing, set FF_COOKIE_DOMAIN=".{yourdomain}" in env
  // domain: process.env.FF_COOKIE_DOMAIN || undefined,
};

const norm = v => (v == null ? '' : String(v)).trim();

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

function makeSid() {
  return crypto.randomBytes(24).toString('base64url');
}

// Minimal session row (optional; safe if table missing)
async function ensureSessionRow(memberId, existing = null) {
  const sid = existing || crypto.randomUUID();
  try {
    await pool.query(
      `INSERT INTO ff_session (session_id, member_id, created_at)
       VALUES ($1,$2,now())
       ON CONFLICT (session_id) DO NOTHING`,
      [sid, memberId]
    );
  } catch {
    // If ff_session table doesn’t exist, silently continue — cookies still work.
  }
  return sid;
}

// Set canonical ff_* cookies using shared helpers.
// ff_sid = HttpOnly server-trusted session; ff_member = readable by JS for UI.
async function setFFSessionCookies(req, res, memberId) {
  const sid = await ensureSessionRow(memberId, req.cookies?.ff_sid || null);
  cookies.setSessionCookie(res, sid);            // HttpOnly, 1y
  cookies.setMemberCookie(res, memberId);        // readable by JS, 1y
  // Optional UI convenience:
  cookies.setCookie(res, 'ff_logged_in', '1', { httpOnly: false, maxAge: 365 * 24 * 60 * 60 * 1000 });
}

// -----------------------------------------------------------------------------
// DB helpers
// -----------------------------------------------------------------------------
async function upsertEspnCred({ swidBrace, s2 }) {
  const swidUuid = swidBrace.slice(1, -1).toLowerCase();
  await pool.query(
    `
    INSERT INTO ff_espn_cred (swid, espn_s2, last_seen)
    VALUES ($1::uuid, NULLIF($2,'') , NOW())
    ON CONFLICT (swid)
    DO UPDATE SET espn_s2 = COALESCE(EXCLUDED.espn_s2, ff_espn_cred.espn_s2),
                  last_seen = NOW()
    `,
    [swidUuid, s2 || null]
  );
}

async function linkFromSwid({ swidBrace }) {
  const swidUuid = swidBrace.slice(1, -1).toLowerCase();
  const { rows } = await pool.query(
    `
    SELECT *
      FROM ff_quickhitter
     WHERE quick_snap = $1
        OR swid       = $2::uuid
     ORDER BY last_seen_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1
    `,
    [swidBrace, swidUuid]
  );

  const row = rows[0];
  if (!row) return { step: 'unlinked' };

  if (!row.swid) {
    await pool.query(`UPDATE ff_quickhitter SET swid=$1::uuid, last_seen_at=NOW() WHERE id=$2`, [swidUuid, row.id]);
  }

  let memberId = norm(row.member_id);
  if (!memberId) {
    memberId = ensureMemberId(row.member_id);
    await pool.query(`UPDATE ff_quickhitter SET member_id=$1, last_seen_at=NOW() WHERE id=$2`, [memberId, row.id]);
  }

  return { step: 'linked', memberId };
}

async function fireIngest(req) {
  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    fetch(`${origin}/api/platforms/espn/ingest/espn/fan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }).catch(() => {});
  } catch {}
}

// -----------------------------------------------------------------------------
// Status endpoints (used by FE)
// -----------------------------------------------------------------------------
router.get('/authcheck', (req, res) => {
  const swid = normalizeSwid(req.cookies?.SWID);
  const s2   = norm(req.cookies?.espn_s2);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, authed: !!(swid && s2) });
});

router.get('/cred', (req, res) => {
  const swid = normalizeSwid(req.cookies?.SWID);
  const s2   = norm(req.cookies?.espn_s2);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, swid, has_s2: !!s2 });
});

// NOTE: this path is under the same router; ensure it’s mounted where your FE calls it:
// e.g., app.use('/api/platforms/espn', router)
router.get('/link-status', (req, res) => {
  const hasMember = !!(req.cookies && req.cookies.ff_member);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, linked: hasMember });
});

// -----------------------------------------------------------------------------
// Main login bounce
// GET /api/espn/login?swid={...}&s2=...&to=/fein/index.html?season=2025
// -----------------------------------------------------------------------------
router.get('/login', async (req, res) => {
  try {
    const swidBrace = normalizeSwid(req.query.swid);
    if (!swidBrace) return res.status(400).json({ ok: false, error: 'bad_swid' });

    const s2      = (req.query.s2 || '').trim();
    const toParam = String(req.query.to || `/fein/?season=${new Date().getUTCFullYear()}`);
    const redirectTo = (() => {
      try { return new URL(toParam, `${req.protocol}://${req.get('host')}`).toString(); }
      catch { return `/fein/?season=${new Date().getUTCFullYear()}`; }
    })();

    // 1) set ESPN cookies on our domain
    res.cookie('SWID', swidBrace, COOKIE_OPTS);
    if (s2) res.cookie('espn_s2', s2, COOKIE_OPTS);

    // 2) persist/refresh creds
    await upsertEspnCred({ swidBrace, s2 });

    // 3) attempt to link SWID → quickhitter → member
    const link = await linkFromSwid({ swidBrace });
    if (link.step === 'linked') {
      await setFFSessionCookies(req, res, link.memberId);

      // Remove espn_s2 from our domain immediately after attestation
      cookies.clearEspnS2(res);

      // 4) kick ingest (headers optional; we keep them for convenience)
      const origin = `${req.protocol}://${req.get('host')}`;
      fetch(`${origin}/api/platforms/espn/ingest/espn/fan`, {
        method: 'POST',
        headers: {
          'X-ESPN-SWID': swidBrace,
          'X-ESPN-S2'  : s2 || '',
          'X-FEIN-KEY' : link.memberId,
        },
      }).catch(() => {});
    }

    // 5) redirect back
    return res.redirect(302, redirectTo);
  } catch (e) {
    console.error('[espn.login]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// -----------------------------------------------------------------------------
// Link using already-set cookies
// POST /api/platforms/espn/link-via-cookie → { ok, step:'linked'|'unlinked', member_id? }
// -----------------------------------------------------------------------------
router.post('/link-via-cookie', async (req, res) => {
  try {
    const swidBrace = normalizeSwid(req.cookies?.SWID);
    const s2 = norm(req.cookies?.espn_s2);
    if (!swidBrace) return res.json({ ok: true, step: 'unlinked' });

    await upsertEspnCred({ swidBrace, s2 });

    const link = await linkFromSwid({ swidBrace });
    if (link.step === 'linked') {
      await setFFSessionCookies(req, res, link.memberId);
      cookies.clearEspnS2(res);
      fireIngest(req);
      return res.json({ ok: true, step: 'linked', member_id: link.memberId });
    }
    return res.json({ ok: true, step: 'unlinked' });
  } catch (e) {
    console.error('[espn.link-via-cookie]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// -----------------------------------------------------------------------------
// Explicitly bind current SWID to a provided memberId
// POST /api/platforms/espn/link { memberId }
// -----------------------------------------------------------------------------
router.post('/link', async (req, res) => {
  try {
    const swidBrace = normalizeSwid(req.cookies?.SWID);
    if (!swidBrace) return res.status(400).json({ ok: false, error: 'no_swid' });
    const swidUuid = swidBrace.slice(1, -1).toLowerCase();

    const memberId = ensureMemberId(req.body?.memberId);
    if (!memberId) return res.status(400).json({ ok: false, error: 'bad_member' });

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

    await setFFSessionCookies(req, res, memberId);
    cookies.clearEspnS2(res);
    fireIngest(req);

    res.json({ ok: true, linked: true, member_id: memberId });
  } catch (e) {
    console.error('[espn.link]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// -----------------------------------------------------------------------------
// Ingest endpoint (MUST NOT 404)
// Mounted under /api/platforms/espn if you use the same router there.
// -----------------------------------------------------------------------------
router.post('/ingest/espn/fan', async (_req, res) => {
  res.status(204).end();
});

// -----------------------------------------------------------------------------
// Asset shims to avoid 404s on the login view
// -----------------------------------------------------------------------------
function noStore(res) { res.set('Cache-Control', 'no-store'); }

router.get(['/auth-state.js', '/js/share-card.js'], (_req, res) => {
  noStore(res);
  res.type('application/javascript').send(`/* shim */ export const ok = true;`);
});

// style shims commonly requested in your logs
router.get([
  '/auth-prompt.css',
  '/styles.css',
  '/timeline/styles.css',
  '/mobile.css',
  '/css/ghostman.css',
  '/css/player-card.css'
], (_req, res) => {
  noStore(res);
  res.type('text/css').send(`/* shim */ :root{--ff:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif}`);
});

module.exports = router;
