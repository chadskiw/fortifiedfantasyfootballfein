// routes/espn/index.js
// Mount once: app.use('/api/platforms/espn', require('./routes/espn'));

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const poolMod = require('../../src/db/pool');
const pool = poolMod.pool || poolMod;
if (!pool || typeof pool.query !== 'function') throw new Error('[espn] pg pool missing');

// ---------------- helpers ----------------
const ok  = (res, body = {}) => res.json({ ok: true, ...body });
const bad = (res, code, error, extra = {}) => res.status(code).json({ ok: false, error, ...extra });
const num = (v, d=null) => (Number.isFinite(+v) ? +v : d);
const sha256 = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');

function normalizeSwid(raw) {
  if (!raw) return null;
  let s = String(raw);
  try { s = decodeURIComponent(s); } catch {}
  s = s.trim().replace(/^\{|\}$/g, '').toUpperCase();
  return `{${s}}`;
}
function normalizeS2(raw) {
  if (!raw) return null;
  let s = String(raw);
  try { s = decodeURIComponent(s); } catch {}
  s = s.replace(/ /g, '+').trim();
  return s || null;
}

async function getAuthedMemberId(req) {
  const c = req.cookies || {};
  const memberId  = (c.ff_member_id || '').trim();
  const sessionId = (c.ff_session_id || '').trim();
  const logged    = (c.ff_logged_in || '') === '1';
  if (!memberId || !sessionId || !logged) return null;
  const { rows } = await pool.query(
    `SELECT 1 FROM ff_session WHERE session_id = $1 AND member_id = $2 LIMIT 1`,
    [sessionId, memberId]
  );
  return rows.length ? memberId : null;
}

// ---------------- DB helpers ----------------

/** Save or update creds and force-attach member_id. */
async function saveCredWithMember({ swid, s2, memberId, ref }) {
  const swidHash = sha256(swid);
  const s2Hash   = sha256(s2);

  // Update by SWID first
  const up = await pool.query(
    `UPDATE ff_espn_cred
        SET espn_s2=$2, s2_hash=$3, swid_hash=$4,
            member_id=$5,
            last_seen=now(),
            ref = COALESCE($6, ref)
      WHERE swid=$1
      RETURNING cred_id`,
    [swid, s2, s2Hash, swidHash, memberId, ref || null]
  );
  if (up.rowCount > 0) return up.rows[0];

  // Else insert
  const ins = await pool.query(
    `INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, member_id, first_seen, last_seen, ref)
     VALUES ($1,$2,$3,$4,$5, now(), now(), $6)
     RETURNING cred_id`,
    [swid, s2, swidHash, s2Hash, memberId, ref || null]
  );
  return ins.rows[0];
}

/** Ensure quick_snap exists; update if row exists, else insert a minimal one. */
async function ensureQuickSnap(memberId, swid) {
  if (!memberId || !swid) return;

  const normalized = normalizeSwid(swid);

  const sel = await pool.query(
    `SELECT id, quick_snap FROM ff_quickhitter WHERE member_id = $1 LIMIT 1`,
    [memberId]
  );
  const row = sel.rows[0];

  if (row) {
    const current = String(row.quick_snap || '').trim();
    if (!current) {
      await pool.query(
        `UPDATE ff_quickhitter
            SET quick_snap = $2,
                updated_at = now()
          WHERE id = $1`,
        [row.id, normalized]
      );
    }
    return;
  }

  // No row for this member — insert a minimal one with the quick_snap
  await pool.query(
    `INSERT INTO ff_quickhitter (member_id, handle, quick_snap, color_hex, created_at, updated_at, is_member)
     VALUES ($1, NULL, $2, COALESCE((SELECT color_hex FROM ff_member WHERE member_id=$1 LIMIT 1), '#77E0FF'), now(), now(), FALSE)`
    , [memberId, normalized]
  );
}

// ---------------- link endpoints ----------------

async function linkHandler(req, res) {
  try {
    const swid = normalizeSwid(req.body?.swid ?? req.query?.swid);
    const s2   = normalizeS2(req.body?.s2   ?? req.query?.s2);
    if (!swid || !s2) return bad(res, 400, 'missing_cred');

    const memberId = await getAuthedMemberId(req);
    const ref = (req.query?.ref || req.body?.ref || '').toString().slice(0, 64) || null;

    await saveCredWithMember({ swid, s2, memberId, ref });
    if (memberId) await ensureQuickSnap(memberId, swid);

    // Cookies for FE convenience
    const maxYear = 1000 * 60 * 60 * 24 * 365;
    const base = { httpOnly: true, sameSite: 'Lax', secure: true, path: '/', maxAge: maxYear };
    res.cookie('SWID', swid, base);
    res.cookie('espn_s2', s2, base);
    res.cookie('fein_has_espn', '1', { ...base, httpOnly: false, maxAge: 1000 * 60 * 60 * 24 * 90 });

    const next = (req.query.to || req.query.return || req.query.next || '/fein').toString();
    return res.redirect(302, next);
  } catch (e) {
    console.error('[espn/link] error', e);
    return bad(res, 500, 'link_failed');
  }
}

router.get('/link',  linkHandler);
router.post('/link', linkHandler);

// ---------------- core FE endpoints ----------------

router.get('/link-status', async (req, res) => {
  try {
    const memberId = await getAuthedMemberId(req);
    if (!memberId) return ok(res, { linked: false, reason: 'no_session' });

    const q = await pool.query(
      `SELECT 1 FROM ff_espn_cred WHERE member_id = $1 AND swid IS NOT NULL AND espn_s2 IS NOT NULL LIMIT 1`,
      [memberId]
    );
    return ok(res, { linked: q.rowCount > 0 });
  } catch (e) {
    console.error('[espn/link-status]', e);
    return bad(res, 500, 'server_error');
  }
});

router.get('/leagues', async (req, res) => {
  try {
    const memberId = await getAuthedMemberId(req);
    if (!memberId) return bad(res, 401, 'unauthorized');

    const season = num(req.query?.season, new Date().getUTCFullYear());

    // TODO: replace with real ESPN fetch using stored creds
    return ok(res, { season, leagues: [] });
  } catch (e) {
    console.error('[espn/leagues]', e);
    return bad(res, 500, 'server_error');
  }
});

/** Primary ingest handler (used by all aliases). */
async function ingestHandler(req, res) {
  try {
    const memberId = await getAuthedMemberId(req);
    if (!memberId) return bad(res, 401, 'unauthorized');

    const season   = num(req.query?.season ?? req.body?.season);
    const leagueId = (req.query?.leagueId ?? req.body?.leagueId ?? '').toString().trim();
    const teamId   = (req.query?.teamId   ?? req.body?.teamId   ?? '').toString().trim() || null;
    if (!season)   return bad(res, 400, 'missing_param', { field: 'season' });
    if (!leagueId) return bad(res, 400, 'missing_param', { field: 'leagueId' });

    // Creds may be forwarded by CF/linker via headers; if present, save & attach.
    const hdrSwid = normalizeSwid(req.headers['x-espn-swid'] || req.headers['x-swid'] || '');
    const hdrS2   = normalizeS2(req.headers['x-espn-s2']   || req.headers['x-s2']   || '');
    if (hdrSwid && hdrS2) {
      await saveCredWithMember({ swid: hdrSwid, s2: hdrS2, memberId, ref: 'ingest' });
      await ensureQuickSnap(memberId, hdrSwid);
    } else {
      // Fall back to filling quick_snap from stored swid if empty
      const row = await pool.query(
        `SELECT swid FROM ff_espn_cred WHERE member_id=$1 AND swid IS NOT NULL ORDER BY last_seen DESC NULLS LAST LIMIT 1`,
        [memberId]
      );
      if (row.rows[0]?.swid) await ensureQuickSnap(memberId, row.rows[0].swid);
      else return bad(res, 412, 'espn_not_linked', { needAuth: true });
    }

    // TODO: kick real ingestion job here
    return res.status(202).json({
      ok: true,
      accepted: true,
      season,
      leagueId: String(leagueId),
      teamId: teamId ? String(teamId) : null
    });
  } catch (e) {
    console.error('[espn/ingest]', e);
    return bad(res, 500, 'server_error');
  }
}

// Primary route
router.post('/ingest', ingestHandler);

// --- Aliases your FE is hitting (avoid 404s) ---
router.post('/ingest/espn/fan', ingestHandler); // seen in your logs

// Poll endpoint used by your PP module — stub so UI loads without 404
router.get('/poll', async (req, res) => {
  try {
    const size = Math.max(1, Math.min(100, num(req.query?.size, 10)));
    const season = num(req.query?.season, new Date().getUTCFullYear());
    return ok(res, {
      season,
      size,
      items: [] // TODO: populate from your PP source; empty list is fine for now
    });
  } catch (e) {
    console.error('[espn/poll]', e);
    return bad(res, 500, 'server_error');
  }
});

// ---------------- misc probes / aliases ----------------

router.get('/cred', (req, res) => {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || null;
  const s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || null;
  res.set('Cache-Control','no-store');
  ok(res, { hasCookies: !!(swid && s2) });
});

router.get('/authcheck', (req, res) => {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || null;
  const s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || null;
  res.set('Cache-Control','no-store');
  ok(res, { step: (swid && s2) ? 'logged_in' : 'link_needed' });
});

module.exports = router;
