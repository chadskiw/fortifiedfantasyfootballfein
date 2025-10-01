// routes/espn/index.js
// Mount once as: app.use('/api/platforms/espn', require('./routes/espn'));

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

let poolMod = require('../../src/db/pool');
const pool = poolMod.pool || poolMod;
if (!pool || typeof pool.query !== 'function') throw new Error('[espn] pg pool missing');

// ---------------- helpers ----------------
const ok  = (res, body = {}) => res.json({ ok: true, ...body });
const bad = (res, code, error, extra = {}) => res.status(code).json({ ok: false, error, ...extra });
const num = (v, d=null) => (Number.isFinite(+v) ? +v : d);
const sha256 = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');

function normalizeSwid(raw) {
  if (!raw) return null;
  // SWID must be uppercase and wrapped in { }
  const s = decodeURIComponent(String(raw)).toUpperCase().trim();
  const core = s.replace(/^\{|\}$/g, '');
  return `{${core}}`;
}
function normalizeS2(raw) {
  if (!raw) return null;
  // ESPN_S2 sometimes arrives with spaces; restore plus signs
  return decodeURIComponent(String(raw)).replace(/ /g, '+').trim();
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

// ---------------- DB helpers (use your existing columns) ----------------
async function upsertCredRow({ swid, s2, memberId, ref }) {
  // If a row exists for this SWID, update; else insert
  // (Your table has cred_id serial/identity, so we use ON CONFLICT on swid)
  const swidHash = sha256(swid);
  const s2Hash   = sha256(s2);

  const q = `
    INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, member_id, first_seen, last_seen, ref)
    VALUES ($1,$2,$3,$4,$5, now(), now(), COALESCE($6, ref))
    ON CONFLICT (swid) DO UPDATE SET
      espn_s2   = EXCLUDED.espn_s2,
      s2_hash   = EXCLUDED.s2_hash,
      swid_hash = EXCLUDED.swid_hash,
      member_id = COALESCE(EXCLUDED.member_id, ff_espn_cred.member_id),
      last_seen = now(),
      ref       = COALESCE(EXCLUDED.ref, ff_espn_cred.ref)
    RETURNING cred_id, member_id;
  `;
  const { rows } = await pool.query(q, [swid, s2, swidHash, s2Hash, memberId || null, ref || null]);
  return rows[0];
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

// ---------------- Link endpoints (keeps your prior behavior) ----------------

async function linkHandler(req, res) {
  try {
    const swid = normalizeSwid(req.body?.swid ?? req.query?.swid);
    const s2   = normalizeS2(req.body?.s2   ?? req.query?.s2);
    if (!swid || !s2) return bad(res, 400, 'missing_cred');

    const memberId = await getAuthedMemberId(req);
    const ref = (req.query?.ref || req.body?.ref || '').toString().slice(0, 64) || null;

    // Write/attach in DB
    await upsertCredRow({ swid, s2, memberId, ref });

    // Set cookies (long-lived)
    const maxYear = 1000 * 60 * 60 * 24 * 365;
    const base = { httpOnly: true, sameSite: 'Lax', secure: true, path: '/', maxAge: maxYear };
    res.cookie('SWID', swid, base);
    res.cookie('espn_s2', s2, base);
    // a readable hint for FE
    res.cookie('fein_has_espn', '1', { ...base, httpOnly: false, maxAge: 1000 * 60 * 60 * 24 * 90 });

    // Kick async work (optional)
    // TODO: wire your real ingest here if you want non-blocking start

    // Redirect back to FEIN or a supplied "next"
    const next = (req.query.to || req.query.return || req.query.next || '/fein').toString();
    return res.redirect(302, next);
  } catch (e) {
    console.error('[espn/link] error', e);
    return bad(res, 500, 'link_failed');
  }
}

router.get('/link',  linkHandler);
router.post('/link', linkHandler);

// ---------------- FE endpoints your FE calls ----------------

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

    // TODO: swap in real ESPN fetch using row.swid / row.espn_s2
    return ok(res, { season, leagues: [] });
  } catch (e) {
    console.error('[espn/leagues]', e);
    return bad(res, 500, 'server_error');
  }
});

router.post('/ingest', async (req, res) => {
  try {
    const memberId = await getAuthedMemberId(req);
    if (!memberId) return bad(res, 401, 'unauthorized');

    const season   = num(req.query?.season ?? req.body?.season);
    const leagueId = (req.query?.leagueId ?? req.body?.leagueId ?? '').toString().trim();
    const teamId   = (req.query?.teamId   ?? req.body?.teamId   ?? '').toString().trim() || null;
    if (!season)   return bad(res, 400, 'missing_param', { field: 'season' });
    if (!leagueId) return bad(res, 400, 'missing_param', { field: 'leagueId' });

    const row = await getCredByMember(memberId);
    if (!row) return bad(res, 412, 'espn_not_linked', { needAuth: true });

    // TODO: perform ingestion using row.swid / row.espn_s2
    return res.status(202).json({ ok: true, accepted: true, season, leagueId, teamId: teamId || null });
  } catch (e) {
    console.error('[espn/ingest]', e);
    return bad(res, 500, 'server_error');
  }
});

// Simple probe some UI bits rely on
router.get('/authcheck', (req, res) => {
  const c = req.cookies || {};
  const hasESPN = !!(
    (c.SWID && (c.espn_s2 || c.ESPN_S2)) ||
    (c.ff_espn_swid && c.ff_espn_s2) ||
    c.fein_has_espn === '1'
  );
  res.set('Cache-Control', 'no-store');
  ok(res, { hasESPN });
});

module.exports = router;
