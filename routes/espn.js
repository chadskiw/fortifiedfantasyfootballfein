// routes/espn.js
// End-to-end ESPN login/link flow + small asset shims to avoid 404s.

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const fetch   = global.fetch || ((...a) => import('node-fetch').then(({default:f}) => f(...a)));

const poolMod = require('../src/db/pool');
const pool = poolMod.pool || poolMod;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[pg] pool.query not available — check require path/export');
}

// >>> use your centralized cookie helpers
const cookies = require('../lib/cookies');

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
  const id = crypto
    .randomBytes(8)
    .toString('base64')
    .replace(/[^A-Z0-9]/gi, '')
    .slice(0, 8)
    .toUpperCase();
  return (id || 'ABCDEFGH').padEnd(8, 'X');
}

// Persist a session row (if you keep one). If not needed, you can no-op this.
async function ensureSessionRow(memberId, existing = null) {
  const sid = existing || crypto.randomUUID();
  await pool.query(
    `INSERT INTO ff_session (session_id, member_id, created_at)
     VALUES ($1,$2,now())
     ON CONFLICT (session_id) DO NOTHING`,
    [sid, memberId]
  );
  return sid;
}

// <-- IMPORTANT: set the cookies your FE/identity use -->
async function setFFSessionCookies(req, res, memberId) {
  // Use your canonical helpers → sets ff_sid (HttpOnly) + ff_member (readable)
  const existing = req.cookies?.ff_sid || null;
  const sid = await ensureSessionRow(memberId, existing);
  cookies.setSessionCookie(res, sid);
  cookies.setMemberCookie(res, memberId);
  // Optional UX flag
  cookies.setCookie(res, 'ff_logged_in', '1', { httpOnly: false, maxAge: 365*24*60*60*1000 });
}

// ---------- DB helpers ----------
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

  // backfill uuid swid if missing
  if (!row.swid) {
    await pool.query(
      `UPDATE ff_quickhitter SET swid=$1::uuid, last_seen_at=NOW() WHERE id=$2`,
      [swidUuid, row.id]
    );
  }

  let memberId = norm(row.member_id);
  if (!memberId) {
    memberId = ensureMemberId(row.member_id);
    await pool.query(
      `UPDATE ff_quickhitter SET member_id=$1, last_seen_at=NOW() WHERE id=$2`,
      [memberId, row.id]
    );
  }

  return { step: 'linked', memberId };
}

async function fireIngest(req, headers = {}) {
  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    fetch(`${origin}/api/platforms/espn/ingest/espn/fan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }).catch(() => {});
  } catch {}
}

// ---------- Status endpoints used by FE ----------
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

router.get('/link-status', (req, res) => {
  // Consider either cookie name to be “linked” (transition-safe)
  const hasMember = !!(norm(req.cookies?.ff_member) || norm(req.cookies?.ff_member_id));
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, linked: hasMember });
});

// ---------- Main login bounce ----------
// GET /api/espn/login?swid={...}&s2=...&to=/fein/index.html?season=2025
router.get('/login', async (req, res) => {
  try {
    const swidBrace = normalizeSwid(req.query.swid);
    if (!swidBrace) return res.status(400).json({ ok:false, error:'bad_swid' });

    const s2 = (req.query.s2 || '').trim();
    const toParam = String(req.query.to || `/fein/?season=${new Date().getUTCFullYear()}`);
    const redirectTo = (() => {
      try { return new URL(toParam, `${req.protocol}://${req.get('host')}`).toString(); }
      catch { return `/fein/?season=${new Date().getUTCFullYear()}`; }
    })();

    // 1) set ESPN cookies (RAW values)
    //    Keep cookie flags consistent with your domain policy via cookies.setCookie
    cookies.setCookie(res, 'SWID', swidBrace, { httpOnly: true, maxAge: 365*24*60*60*1000 });
    if (s2) {
      cookies.setCookie(res, 'espn_s2', s2, { httpOnly: true, maxAge: 6 * 60 * 60 * 1000 }); // short TTL
      cookies.setCookie(res, 'ESPN_S2', s2, { httpOnly: true, maxAge: 6 * 60 * 60 * 1000 });
    }

    // 2) persist/refresh creds
    await upsertEspnCred({ swidBrace, s2 });

    // 3) try to bind SWID → quickhitter → member
    const link = await linkFromSwid({ swidBrace });
    if (link.step === 'linked') {
      await setFFSessionCookies(req, res, link.memberId);

      // (optional) remove espn_s2 from our domain now that we attested it
      cookies.clearEspnS2(res);

      // 4) kick ingest with explicit headers so any upstream checks can pass
      const headers = {
        'X-ESPN-SWID': swidBrace,
        'X-ESPN-S2'  : s2 || '',
        'X-FEIN-KEY' : link.memberId,
      };
      fireIngest(req, headers);
    }

    // 5) bounce back
    return res.redirect(302, redirectTo);
  } catch (e) {
    console.error('[espn.login]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// ---------- Link using already-set cookies ----------
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

// ---------- Explicit bind current SWID -> member ----------
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

// ---------- Ingest endpoint (must NOT 404) ----------
router.post('/ingest/espn/fan', async (_req, res) => {
  // if you have a worker/job, dispatch here. For now: accept quickly.
  res.status(204).end();
});

// ---------- Tiny asset shims so the login view never 404s ----------
function noStore(res) { res.set('Cache-Control', 'no-store'); }

router.get(['/auth-state.js', '/js/share-card.js'], (_req, res) => {
  noStore(res);
  res.type('application/javascript').send(
    `/* shim */ export const ok=true;`
  );
});

router.get(['/auth-prompt.css', '/styles.css'], (_req, res) => {
  noStore(res);
  res.type('text/css').send(
    `/* shim */ :root{--ff:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif}`
  );
});

module.exports = router;
