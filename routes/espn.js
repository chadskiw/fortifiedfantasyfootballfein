// routes/espn.js
// ESPN login/link flow for Fortified Fantasy (focused version).
// - Creates/updates member + session cookies on /login when swid/s2 are present
// - Persists ESPN credentials
// - Triggers ingest
// - Provides tiny asset shims so the login page never 404s

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const fetch = global.fetch || ((...a) =>
  import('node-fetch').then(({ default: f }) => f(...a)));

const pool = require('../src/db/pool');             // ✅ your PG pool
const cookies = require('../lib/cookies');      // ✅ the cookie helpers we added

if (!pool || typeof pool.query !== 'function') {
  throw new Error('[espn] pool.query not available — check ../src/db/pool export');
}

// -------------------- helpers --------------------

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
  // create an 8-char, uppercase, URL-safe id
  const id = crypto.randomBytes(8).toString('base64url')
    .replace(/[^A-Z0-9]/gi, '')
    .slice(0, 8)
    .toUpperCase();
  return (id || 'ABCDEFGH').padEnd(8, 'X');
}

function makeSid() {
  // server-trusted session id (stored in ff_session for auditing)
  return crypto.randomUUID();
}

async function ensureDbSession(sessionId, memberId) {
  await pool.query(
    `INSERT INTO ff_session (session_id, member_id, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, memberId]
  );
  return sessionId;
}

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

// Try to find a member via prior quickhitter link; create one if needed.
async function findOrCreateMemberFromSwid(swidBrace) {
  const swidUuid = swidBrace.slice(1, -1).toLowerCase();
  const { rows } = await pool.query(
    `
    SELECT id, member_id, quick_snap, swid
      FROM ff_quickhitter
     WHERE quick_snap = $1
        OR swid       = $2::uuid
     ORDER BY last_seen_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1
    `,
    [swidBrace, swidUuid]
  );

  if (rows.length === 0) {
    // No prior record — create a lightweight link row with a new member id
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

  const row = rows[0];
  let memberId = norm(row.member_id);
  if (!memberId) {
    memberId = ensureMemberId();
    await pool.query(
      `UPDATE ff_quickhitter SET member_id=$1, last_seen_at=NOW() WHERE id=$2`,
      [memberId, row.id]
    );
  } else {
    await pool.query(
      `UPDATE ff_quickhitter SET last_seen_at=NOW() WHERE id=$1`,
      [row.id]
    );
  }

  // Backfill uuid swid if missing
  if (!row.swid) {
    await pool.query(
      `UPDATE ff_quickhitter SET swid=$1::uuid WHERE id=$2`,
      [swidUuid, row.id]
    );
  }

  return memberId;
}

async function fireIngest(req, { swidBrace, s2, memberId }) {
  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    // We include headers so any downstream verify step sees what we saw here.
    fetch(`${origin}/api/platforms/espn/ingest/espn/fan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-espn-swid': swidBrace,
        'x-espn-s2'  : s2 || '',
        'x-fein-key' : memberId
      },
      // no body required right now
    }).catch(() => {});
  } catch {}
}

// -------------------- small status endpoints (FE uses these) --------------------

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
    res.cookie('SWID', swidBrace, {
      path: '/',
      sameSite: 'Lax',
      secure: true,
      httpOnly: true, // we don’t need JS to read this
    });
    res.cookie('espn_s2', s2, {
      path: '/',
      sameSite: 'Lax',
      secure: true,
      httpOnly: true,
    });
    // (Some clients look for this alias)
    res.cookie('ESPN_S2', s2, {
      path: '/',
      sameSite: 'Lax',
      secure: true,
      httpOnly: true,
    });

    // 2) persist / refresh creds
    await upsertEspnCred({ swidBrace, s2 });

    // 3) find or create a member tied to this SWID
    const memberId = await findOrCreateMemberFromSwid(swidBrace);

    // 4) create a server session + set app cookies
    const sid = await ensureDbSession(makeSid(), memberId);
    cookies.setSessionCookie(res, sid);          // sets HttpOnly ff_sid
    cookies.setMemberCookie(res, memberId);      // sets readable ff_member
    // (optional) clear espn_s2 after attestation if you don't need it anymore:
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

// -------------------- Link using existing cookies --------------------

router.post('/link-via-cookie', async (req, res) => {
  try {
    const swidBrace = normalizeSwid(req.cookies?.SWID);
    const s2        = norm(req.cookies?.espn_s2);
    if (!swidBrace || !s2) return res.json({ ok: true, step: 'unlinked' });

    await upsertEspnCred({ swidBrace, s2 });

    const memberId = await findOrCreateMemberFromSwid(swidBrace);

    const sid = await ensureDbSession(makeSid(), memberId);
    cookies.setSessionCookie(res, sid);
    cookies.setMemberCookie(res, memberId);
    fireIngest(req, { swidBrace, s2, memberId });

    return res.json({ ok: true, step: 'linked', member_id: memberId });
  } catch (e) {
    console.error('[espn.link-via-cookie]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// -------------------- Explicitly bind current SWID -> provided member --------------------

router.post('/link', async (req, res) => {
  try {
    const swidBrace = normalizeSwid(req.cookies?.SWID);
    if (!swidBrace) return res.status(400).json({ ok: false, error: 'no_swid' });
    const swidUuid = swidBrace.slice(1, -1).toLowerCase();

    const memberId = ensureMemberId(req.body?.memberId);
    await pool.query(
      `
      INSERT INTO ff_quickhitter (member_id, quick_snap, swid, last_seen_at, created_at)
      VALUES ($1, $2, $3::uuid, NOW(), NOW())
      ON CONFLICT (member_id)
      DO UPDATE SET quick_snap  = EXCLUDED.quick_snap,
                    swid        = EXCLUDED.swid,
                    last_seen_at= NOW()
      `,
      [memberId, swidBrace, swidUuid]
    );

    const sid = await ensureDbSession(makeSid(), memberId);
    cookies.setSessionCookie(res, sid);
    cookies.setMemberCookie(res, memberId);
    fireIngest(req, { swidBrace, s2: norm(req.cookies?.espn_s2), memberId });

    res.json({ ok: true, linked: true, member_id: memberId });
  } catch (e) {
    console.error('[espn.link]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// -------------------- Ingest endpoint (must NOT 404) --------------------

router.post('/ingest/espn/fan', async (_req, res) => {
  // If you have a worker/job, dispatch here. For now: accept quickly.
  res.status(204).end();
});

// -------------------- Tiny asset shims (avoid 404 during login UX) --------------------

function noStore(res) { res.set('Cache-Control', 'no-store'); }

router.get(['/auth-state.js', '/js/share-card.js'], (_req, res) => {
  noStore(res);
  res.type('application/javascript').send(`/* shim */ export const ok=true;`);
});

router.get(['/auth-prompt.css', '/styles.css', '/timeline/styles.css', '/mobile.css', '/css/player-card.css', '/css/ghostman.css'], (_req, res) => {
  noStore(res);
  res.type('text/css').send(`/* shim */ :root{--ff:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif}`);
});

module.exports = router;
