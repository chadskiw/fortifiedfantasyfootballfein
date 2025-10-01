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
  let s = decodeURIComponent(String(raw)).trim();
  // ensure braces; upper-case inside
  s = s.replace(/^\{|\}$/g, '').toUpperCase();
  return `{${s}}`;
}
function normalizeS2(raw) {
  if (!raw) return null;
  // ESPN_S2 sometimes arrives url-encoded or with spaces
  let s = String(raw);
  try { s = decodeURIComponent(s); } catch {}
  s = s.replace(/ /g, '+').trim();
  return s || null;
}

/**
 * Convert any SWID to "{Number}" format:
 * - If it's already "{123...}" return as-is.
 * - Else, strip all non-digits and wrap in braces. If no digits exist, fall back to "{0}".
 */
function swidToBraceNumber(swid) {
  if (!swid) return '{0}';
  const trimmed = String(swid).trim();
  if (/^\{\d+\}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D+/g, '');
  return `{${digits || '0'}}`;
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

/**
 * Save or update creds and force-attach member_id.
 * Works even if (swid) doesn't have a unique constraint.
 */
async function saveCredWithMember({ swid, s2, memberId, ref }) {
  const swidHash = sha256(swid);
  const s2Hash   = sha256(s2);

  // Try UPDATE by exact swid first
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

  // Else INSERT
  const ins = await pool.query(
    `INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, member_id, first_seen, last_seen, ref)
     VALUES ($1,$2,$3,$4,$5, now(), now(), $6)
     RETURNING cred_id`,
    [swid, s2, swidHash, s2Hash, memberId, ref || null]
  );
  return ins.rows[0];
}

async function getCredByMember(memberId) {
  const q = await pool.query(
    `SELECT cred_id, swid, espn_s2, swid_hash, s2_hash
       FROM ff_espn_cred
      WHERE member_id = $1
      ORDER BY last_seen DESC NULLS LAST, first_seen DESC
      LIMIT 1`,
    [memberId]
  );
  const row = q.rows[0];
  if (row) await pool.query(`UPDATE ff_espn_cred SET last_seen = now() WHERE cred_id = $1`, [row.cred_id]);
  return row || null;
}

/** If user has no quick_snap, set it to SWID in "{Number}" format. */
async function ensureQuickSnap(memberId, swid) {
  if (!memberId || !swid) return;
  const qs = await pool.query(
    `SELECT quick_snap FROM ff_quickhitter WHERE member_id = $1 LIMIT 1`,
    [memberId]
  );
  const current = qs.rows[0]?.quick_snap || '';
  if (current && String(current).trim() !== '') return; // already set

  // Use normalized SWID (already looks like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX})
  const normalized = normalizeSwid(swid);
  await pool.query(
    `UPDATE ff_quickhitter SET quick_snap = $2, updated_at = now() WHERE member_id = $1`,
    [memberId, normalized]
  );
}


// ---------------- Link endpoints (kept) ----------------

async function linkHandler(req, res) {
  try {
    const swid = normalizeSwid(req.body?.swid ?? req.query?.swid);
    const s2   = normalizeS2(req.body?.s2   ?? req.query?.s2);
    if (!swid || !s2) return bad(res, 400, 'missing_cred');

    const memberId = await getAuthedMemberId(req);
    const ref = (req.query?.ref || req.body?.ref || '').toString().slice(0, 64) || null;

    // Save creds and force-attach member_id
    await saveCredWithMember({ swid, s2, memberId, ref });

    // If no quick_snap, set it to {Number} from SWID
    if (memberId) await ensureQuickSnap(memberId, swid);

    // Set cookies for FE convenience
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

// ---------------- FE endpoints ----------------

router.get('/link-status', async (req, res) => {
  try {
    const memberId = await getAuthedMemberId(req);
    if (!memberId) return ok(res, { linked: false, reason: 'no_session' });
    const row = await getCredByMember(memberId);
    return ok(res, { linked: !!(row?.swid && row?.espn_s2) });
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
    const row = await getCredByMember(memberId);
    if (!row) return ok(res, { season, leagues: [] });

    // TODO: replace with real ESPN fetch using row.swid / row.espn_s2
    return ok(res, { season, leagues: [] });
  } catch (e) {
    console.error('[espn/leagues]', e);
    return bad(res, 500, 'server_error');
  }
});

/**
 * POST /api/platforms/espn/ingest?season=YYYY&leagueId=...&teamId=...
 * Requirements you asked for:
 *  - If member has no quick_snap, upsert SWID as {Number}.
 *  - Ensure ff_espn_cred has member_id set (attach/overwrite).
 * We read SWID/S2 from headers if provided by your link function (x-espn-swid/x-espn-s2).
 */
router.post('/ingest', async (req, res) => {
  try {
    const memberId = await getAuthedMemberId(req);
    if (!memberId) return bad(res, 401, 'unauthorized');

    const season   = num(req.query?.season ?? req.body?.season);
    const leagueId = (req.query?.leagueId ?? req.body?.leagueId ?? '').toString().trim();
    const teamId   = (req.query?.teamId   ?? req.body?.teamId   ?? '').toString().trim() || null;
    if (!season)   return bad(res, 400, 'missing_param', { field: 'season' });
    if (!leagueId) return bad(res, 400, 'missing_param', { field: 'leagueId' });

    // Take SWID/S2 from headers if provided by CF function, otherwise from db
    const hdrSwid = normalizeSwid(req.headers['x-espn-swid'] || req.headers['x-swid'] || '');
    const hdrS2   = normalizeS2(req.headers['x-espn-s2']   || req.headers['x-s2']   || '');

    if (hdrSwid && hdrS2) {
      await saveCredWithMember({ swid: hdrSwid, s2: hdrS2, memberId, ref: 'ingest' });
      await ensureQuickSnap(memberId, hdrSwid);
    } else {
      // No headers: still ensure we have creds and quick_snap if possible
      const existing = await getCredByMember(memberId);
      if (existing?.swid) await ensureQuickSnap(memberId, existing.swid);
      if (!existing?.espn_s2) {
        // not linked → tell FE to open auth
        return bad(res, 412, 'espn_not_linked', { needAuth: true });
      }
    }

    // TODO: kick off real ingest here (background job / queue)
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
});

// Simple probe for some UIs
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
