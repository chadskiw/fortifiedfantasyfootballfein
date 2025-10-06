// routes/espn.js
// End-to-end ESPN login/link flow + tiny asset shims (no 404s).

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const fetch   = global.fetch || ((...a) => import('node-fetch').then(({default:f}) => f(...a)));

const poolMod = require('../src/db/pool');
const pool    = poolMod.pool || poolMod;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[pg] pool.query not available — check require path/export');
}

const cookies = require('../src/lib/cookies'); // <- your cookie helpers

// ---------- small utils ----------
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
  // any opaque session id is fine; we store it server-side
  return crypto.randomBytes(24).toString('base64url');
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

/**
 * Return an existing member for this SWID, or create one bound in ff_quickhitter.
 * @returns {Promise<string>} memberId
 */
async function findOrCreateMemberFromSwid(swidBrace) {
  const swidUuid = swidBrace.slice(1, -1).toLowerCase();

  // try to find any quickhitter that references this swid or quick_snap = brace form
  const { rows } = await pool.query(
    `
      SELECT id, member_id, swid, quick_snap
        FROM ff_quickhitter
       WHERE swid = $1::uuid OR quick_snap = $2
       ORDER BY last_seen_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC
       LIMIT 1
    `,
    [swidUuid, swidBrace]
  );

  // found → ensure member_id present and backfill swid/last_seen_at
  if (rows.length) {
    let memberId = norm(rows[0].member_id);
    if (!memberId) {
      memberId = ensureMemberId();
      await pool.query(
        `UPDATE ff_quickhitter SET member_id=$1, last_seen_at=NOW() WHERE id=$2`,
        [memberId, rows[0].id]
      );
    }
    if (!rows[0].swid) {
      await pool.query(
        `UPDATE ff_quickhitter SET swid=$1::uuid, last_seen_at=NOW() WHERE id=$2`,
        [swidUuid, rows[0].id]
      );
    }
    return memberId;
  }

  // not found → create a new quickhitter bound to this swid with a fresh member id
  const memberId = ensureMemberId();
  await pool.query(
    `
      INSERT INTO ff_quickhitter (member_id, quick_snap, swid, last_seen_at, created_at)
      VALUES ($1, $2, $3::uuid, NOW(), NOW())
      ON CONFLICT (member_id) DO NOTHING
    `,
    [memberId, swidBrace, swidUuid]
  );
  return memberId;
}

/** Insert a session row if you store sessions in DB (optional but recommended). */
async function ensureDbSession(sessionId, memberId) {
  await pool.query(
    `
      INSERT INTO ff_session (session_id, member_id, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (session_id) DO NOTHING
    `,
    [sessionId, memberId]
  );
  return sessionId;
}

/** Fire-and-forget ingest */
function fireIngest(req, { swidBrace, s2, memberId }) {
  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    fetch(`${origin}/api/platforms/espn/ingest/espn/fan`, {
      method: 'POST',
      headers: {
        'X-ESPN-SWID': swidBrace,
        'X-ESPN-S2'  : s2 || '',
        'X-FEIN-KEY' : memberId || '',
        'content-type': 'application/json',
      },
      body: '{}',
    }).catch(() => {});
  } catch {}
}

// ---------- Status endpoints (used by FE) ----------
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
  const hasMember = !!norm(req.cookies?.ff_member);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, linked: hasMember });
});

// -------------------- MAIN: /login --------------------
// GET /api/espn/login?swid={...}&s2=...&to=/fein/index.html?season=2025
router.get('/login', async (req, res) => {
  try {
    const swidBrace = normalizeSwid(req.query.swid);
    const s2        = norm(req.query.s2);

    if (!swidBrace || !s2) {
      return res.status(400).json({ ok: false, error: 'missing_swid_or_s2' });
    }

    // Where to return after we finish
    const toParam = String(req.query.to || `/fein/?season=${new Date().getUTCFullYear()}`);
    const redirectTo = (() => {
      try { return new URL(toParam, `${req.protocol}://${req.get('host')}`).toString(); }
      catch { return `/fein/?season=${new Date().getUTCFullYear()}`; }
    })();

    // 1) set *ESPN* cookies on our domain (these are the attestation source)
    //    HttpOnly is fine; we don’t need JS to read them.
    const shared = { path: '/', sameSite: 'Lax', secure: true, httpOnly: true };
    res.cookie('SWID',    swidBrace, shared);
    res.cookie('espn_s2', s2,        shared);
    res.cookie('ESPN_S2', s2,        shared); // alias used by some clients

    // 2) persist / refresh creds
    await upsertEspnCred({ swidBrace, s2 });

    // 3) find or create a member tied to this SWID
    const memberId = await findOrCreateMemberFromSwid(swidBrace);

    // 4) create a server session + set app cookies
    const sid = await ensureDbSession(makeSid(), memberId);
    cookies.setSessionCookie(res, sid);     // HttpOnly ff_sid
    cookies.setMemberCookie(res, memberId); // readable ff_member
    // If you prefer to immediately remove espn_s2 from your domain after attestation, uncomment:
    // cookies.clearEspnS2(res);

    // 5) kick ingest (fire-and-forget)
    fireIngest(req, { swidBrace, s2, memberId });

    // 6) bounce back to the app
    return res.redirect(302, redirectTo);
  } catch (e) {
    console.error('[espn.login] error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- Link using already-set cookies ----------
router.post('/link-via-cookie', async (req, res) => {
  try {
    const swidBrace = normalizeSwid(req.cookies?.SWID);
    const s2        = norm(req.cookies?.espn_s2);
    if (!swidBrace) return res.json({ ok: true, step: 'unlinked' });

    await upsertEspnCred({ swidBrace, s2 });

    const memberId = await findOrCreateMemberFromSwid(swidBrace);
    const sid = await ensureDbSession(makeSid(), memberId);
    cookies.setSessionCookie(res, sid);
    cookies.setMemberCookie(res, memberId);
    fireIngest(req, { swidBrace, s2, memberId });

    return res.json({ ok: true, step: 'linked', member_id: memberId });
  } catch (e) {
    console.error('[espn.link-via-cookie] error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- Explicit bind current SWID -> member ----------
router.post('/link', express.json({ limit: '256kb' }), async (req, res) => {
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

    const sid = await ensureDbSession(makeSid(), memberId);
    cookies.setSessionCookie(res, sid);
    cookies.setMemberCookie(res, memberId);
    fireIngest(req, { swidBrace, s2: norm(req.cookies?.espn_s2), memberId });

    res.json({ ok: true, linked: true, member_id: memberId });
  } catch (e) {
    console.error('[espn.link] error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- Ingest endpoint (must NOT 404) ----------
router.post('/ingest/espn/fan', async (_req, res) => {
  // If you have a background worker/job, dispatch here. For now: accept quickly.
  res.status(204).end();
});

// ---------- Tiny asset shims so the login view never 404s ----------
function noStore(res) { res.set('Cache-Control', 'no-store'); }

router.get(['/auth-state.js', '/js/share-card.js'], (_req, res) => {
  noStore(res);
  res.type('application/javascript').send(`/* shim */ export const ok=true;`);
});

router.get(['/auth-prompt.css', '/styles.css', '/timeline/styles.css', '/mobile.css'], (_req, res) => {
  noStore(res);
  res.type('text/css').send(`/* shim */ :root{--ff:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif}`);
});

module.exports = router;
