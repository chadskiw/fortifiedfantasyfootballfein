// routes/platforms/espn/index.js
const express = require('express');
const router  = express.Router();

let db;
try { db = require('../../src/db/pool'); } catch { db = require('../../src/db/pool'); }
const pool = db.pool || db;

const fetch = global.fetch || require('node-fetch');
const crypto = require('crypto');

// -------- Helpers --------
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const SWID_RE = /^\{[0-9A-Fa-f-]{36}\}$/;

function memberFromCookies(req){
  const c = req.cookies || {};
  return (c.ff_member_id || c.ff_member || '').trim() || null;
}
const mask = (str='', left=6, right=4) => {
  const s = String(str); if (!s) return '';
  if (s.length <= left + right) return '***';
  return s.slice(0,left) + '…' + s.slice(-right);
};

// Pull latest ESPN cred for a member; fallbacks are quick_snap and SWID cookie
async function getCredForMember(req){
  const member_id = memberFromCookies(req);
  const cookies   = req.cookies || {};
  const swidCookie = cookies.SWID || cookies.swid || null;

  if (!member_id) {
    // no member: only possible fallback is SWID cookie + (no s2)
    return { swid: swidCookie || null, espn_s2: null, member_id: null };
  }

  const sql = `
    WITH c AS (
      SELECT swid, espn_s2, last_seen
        FROM ff_espn_cred
       WHERE member_id = $1
       ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
       LIMIT 1
    ),
    q AS (
      SELECT quick_snap
        FROM ff_quickhitter
       WHERE member_id = $1
       LIMIT 1
    )
    SELECT
      (SELECT swid FROM c)         AS swid,
      (SELECT espn_s2 FROM c)      AS espn_s2,
      (SELECT quick_snap FROM q)   AS quick_snap
  `;
  const { rows } = await pool.query(sql, [member_id]);
  const row = rows[0] || {};

  let swid = row.swid || row.quick_snap || swidCookie || null;
  if (swid && /^[0-9A-Fa-f-]{36}$/.test(String(swid))) swid = `{${swid}}`; // brace it if bare GUID

  return {
    swid: swid || null,
    espn_s2: row.espn_s2 || null,
    member_id
  };
}

// Require cred for protected calls
async function ensureCredFromDB(req, res, next){
  try{
    const cred = await getCredForMember(req);
    if (!cred?.swid || !cred?.espn_s2) {
      return res.status(401).json({
        ok: false,
        error: 'Missing SWID/espn_s2',
        hint: 'Link your ESPN via bookmarklet or /api/platforms/espn/link'
      });
    }
    req._espn = cred;
    next();
  }catch(e){
    console.error('[espn ensureCred]', e);
    res.status(500).json({ ok:false, error:'cred_lookup_failed' });
  }
}

// Attach both Cookie + X- headers (ESPN accepts either; Cookie is canonical)
async function espnFetchJSON(url, cred, init={}){
  const headers = Object.assign({}, init.headers || {});
  headers['X-ESPN-SWID'] = encodeURIComponent(cred.swid || '');
  headers['X-ESPN-S2']   = cred.espn_s2 || '';
  headers['cookie'] = [
    `SWID=${cred.swid || ''}`,         // cookie wants raw braces
    `espn_s2=${cred.espn_s2 || ''}`
  ].join('; ');

  const res = await fetch(url, { method:'GET', ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    const err = new Error(`[${res.status}] ${url} → ${text || 'request failed'}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------------- PUBLIC STATUS ENDPOINTS ----------------------

/**
 * GET /api/platforms/espn/cred
 * Lightweight probe for the UI. No S2 leaks.
 */
router.get('/cred', async (req,res)=>{
  try{
    const { swid, espn_s2 } = await getCredForMember(req);
    res.json({
      ok: true,
      linked: Boolean(swid || espn_s2),
      swid: swid || null,
      hasS2: Boolean(espn_s2),
      s2_masked: espn_s2 ? mask(espn_s2) : null
    });
  }catch(e){
    res.json({ ok:true, linked:false });
  }
});

/**
 * GET /api/platforms/espn/link-status
 * Drives the big UI banner/badges.
 */
router.get('/link-status', async (req,res)=>{
  try{
    const { swid, espn_s2 } = await getCredForMember(req);
    const hasValidSwid = !!(swid && SWID_RE.test(String(swid)));
    res.json({
      ok: true,
      linked: hasValidSwid || Boolean(espn_s2),
      swid: hasValidSwid ? String(swid) : null,
      hasS2: Boolean(espn_s2)
    });
  }catch(e){
    res.json({ ok:true, linked:false });
  }
});

// ---------------------- LEGACY LINK (bookmarklet) ----------------------

/**
 * GET /api/espn/link
 * Upserts ff_espn_cred and sets quick_snap if empty; redirects back.
 */
router.get('/../../espn/link', async (req, res) => {
  try {
    const member_id = memberFromCookies(req);
    const swid = String(req.query.swid || '').trim();
    const s2   = String(req.query.s2   || '').trim();
    const ret  = String(req.query.to   || '/fein').trim() || '/fein';

    if (!member_id) return res.redirect(ret);
    if (!SWID_RE.test(swid)) return res.redirect(ret);

    const swid_hash = sha256(swid);
    const s2_hash   = s2 ? sha256(s2) : null;

    await pool.query(`
      INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, member_id, first_seen, last_seen, ref)
      VALUES ($1,$2,$3,$4,$5, now(), now(), 'link')
      ON CONFLICT (swid_hash) DO UPDATE
         SET espn_s2  = COALESCE(EXCLUDED.espn_s2, ff_espn_cred.espn_s2),
             s2_hash  = COALESCE(EXCLUDED.s2_hash, ff_espn_cred.s2_hash),
             member_id= COALESCE(ff_espn_cred.member_id, EXCLUDED.member_id),
             last_seen= now()
    `, [swid, s2 || null, swid_hash, s2_hash, member_id]);

    await pool.query(`
      UPDATE ff_quickhitter
         SET quick_snap = COALESCE(quick_snap, $2),
             updated_at = now()
       WHERE member_id = $1
    `, [member_id, swid]);

    res.redirect(ret);
  } catch (e) {
    console.error('[espn/link]', e);
    res.redirect(String(req.query.to || '/fein'));
  }
});

// ---------------------- COMPAT / POLL ----------------------
router.post('/ingest/espn/fan', (req,res)=>{
  res.json({ ok:true, deprecated:true, use:'link-status' });
});
router.get('/poll', async (req,res)=>{
  req.url = '/link-status';
  router.handle(req, res);
});

// ---------------------- NEW PROXY ENDPOINTS ----------------------

/**
 * GET /api/platforms/espn/teams?season=2025&leagueId=1634950747
 */
router.get('/teams', ensureCredFromDB, async (req,res)=>{
  try{
    const { season, leagueId } = req.query;
    if (!season || !leagueId) {
      return res.status(400).json({ ok:false, error:'season and leagueId required' });
    }
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam&view=mSettings`;
    const data = await espnFetchJSON(url, req._espn);
    const teams = (data.teams || []).map(t => ({
      id: t.id,
      location: t.location,
      nickname: t.nickname,
      logo: t.logo || null,
      owners: t.owners || []
    }));
    res.json({ ok:true, teams });
  }catch(e){
    res.status(e.status || 500).json({ ok:false, error:e.message });
  }
});

/**
 * GET /api/platforms/espn/roster?season=2025&leagueId=...&teamId=7&week=2
 */
router.get('/roster', ensureCredFromDB, async (req,res)=>{
  try{
    const { season, leagueId, teamId } = req.query;
    const week = req.query.week ? Number(req.query.week) : undefined;
    if (!season || !leagueId || !teamId) {
      return res.status(400).json({ ok:false, error:'season, leagueId, teamId required' });
    }

    const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
    const view = week ? `mRoster&scoringPeriodId=${week}` : 'mRoster';
    const url  = `${base}?forTeamId=${teamId}&view=${view}`;

    const data = await espnFetchJSON(url, req._espn);
    const team = (data.teams || []).find(t => String(t.id) === String(teamId)) || {};
    const entries = (team.roster && team.roster.entries) || [];
    res.json({ ok:true, entries });
  }catch(e){
    res.status(e.status || 500).json({ ok:false, error:e.message });
  }
});

module.exports = router;
