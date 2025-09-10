// routes/fein-auth.js  (DROP-IN)
// CommonJS; depends on ../src/db exporting `query` and ../auth exporting `readAuthFromRequest`

const express = require('express');
const { query } = require('../src/db');
const { readAuthFromRequest } = require('../auth');

const router = express.Router();
const WRITE_KEY = (process.env.FEIN_AUTH_KEY || '').trim();

// Helpers
const ok   = (res, data) => res.json({ ok: true, ...data });
const bad  = (res, msg)  => res.status(400).json({ ok: false, error: msg || 'Bad request' });
const boom = (res, err)  => res.status(500).json({ ok: false, error: String(err?.message || err) });

const s = v => (v == null ? '' : String(v));
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const dedup = arr => Array.from(new Set((arr || []).flat().map(x => s(x).trim()).filter(Boolean)));

// ---------------------------------------------------------------------------
// GET /fein-auth/by-league?season=2025&size=12[&leagueId=...]
router.get('/by-league', async (req, res) => {
  try {
    const season   = s(req.query.season || '').trim();
    const size     = Number(req.query.size || '');
    const leagueId = s(req.query.leagueId || '').trim();

    if (!season) return bad(res, 'season required');
    if (!Number.isFinite(size)) return bad(res, 'size required');

    const params = [season, size];
    let sql = `
      SELECT season, league_id, team_id, name AS team_name, handle,
             league_size, fb_groups, updated_at
      FROM fein_meta
      WHERE season = $1 AND league_size = $2
    `;
    if (leagueId) { sql += ` AND league_id = $3`; params.push(leagueId); }
    sql += ` ORDER BY league_id, team_id`;

    const rows = await query(sql, params).then(r => r.rows);
    return ok(res, { count: rows.length, rows });
  } catch (e) { return boom(res, e); }
});

// ---------------------------------------------------------------------------
// GET /fein-auth/pool?size=12[&season=2025]
router.get('/pool', async (req, res) => {
  try {
    const size   = Number(req.query.size || '');
    const season = s(req.query.season || '').trim();
    if (!Number.isFinite(size)) return bad(res, 'size required');

    const params = [size];
    let sql = `
      SELECT season, league_id, team_id, name AS team_name, handle,
             league_size, fb_groups, updated_at
      FROM fein_meta
      WHERE league_size = $1
    `;
    if (season) { sql += ` AND season = $2`; params.push(season); }
    sql += ` ORDER BY season DESC, league_id, team_id`;

    const rows = await query(sql, params).then(r => r.rows);
    return ok(res, { count: rows.length, rows });
  } catch (e) { return boom(res, e); }
});

// ---------------------------------------------------------------------------
// POST /fein-auth/upsert-meta   (requires x-fein-key if FEIN_AUTH_KEY is set)
router.post('/upsert-meta', async (req, res) => {
  try {
    if (WRITE_KEY) {
      const k = s(req.headers['x-fein-key'] || '').trim();
      if (!k || k !== WRITE_KEY) return res.status(401).json({ ok:false, error:'Unauthorized (bad x-fein-key)' });
    }

    const b = req.body || {};

    const leagueId   = s(b.leagueId || b.league_id).trim();
    const teamId     = s(b.teamId   || b.team_id).trim();
    const season     = s(b.season || new Date().getFullYear()).trim();
    const leagueSize = n(b.leagueSize ?? b.league_size);
    const name       = s(b.teamName ?? b.name).slice(0,120);
    const handle     = s(b.owner    ?? b.handle).slice(0,120);
    const fb_groups  = Array.isArray(b.fb_groups) ? b.fb_groups : dedup([b.fbName, b.fbHandle, b.fbGroup]);

    // creds from body OR headers/cookies/query
    let swid = s(b.swid || b.SWID);
    let s2   = s(b.s2   || b.espn_s2);
    if (!swid || !s2) {
      const fromReq = readAuthFromRequest?.(req) || {};
      if (!swid) swid = fromReq.swid || '';
      if (!s2)   s2   = fromReq.s2   || '';
    }

    if (!leagueId || !teamId || !season)
      return bad(res, 'leagueId, teamId, season required');

    const sql = `
      INSERT INTO fein_meta (season, league_id, team_id, name, handle, league_size, fb_groups, swid, s2, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
      ON CONFLICT (season, league_id, team_id)
      DO UPDATE SET
        name        = COALESCE(EXCLUDED.name, fein_meta.name),
        league_size = COALESCE(EXCLUDED.league_size, fein_meta.league_size),
        handle      = COALESCE(NULLIF(EXCLUDED.handle,''), fein_meta.handle),
        fb_groups   = CASE
                        WHEN EXCLUDED.fb_groups IS NOT NULL AND jsonb_array_length(EXCLUDED.fb_groups) > 0
                        THEN (
                          SELECT jsonb_agg(DISTINCT x)
                          FROM jsonb_array_elements(COALESCE(fein_meta.fb_groups,'[]'::jsonb) || EXCLUDED.fb_groups) t(x)
                        )
                        ELSE fein_meta.fb_groups
                      END,
        swid        = COALESCE(NULLIF(EXCLUDED.swid,''), fein_meta.swid),
        s2          = COALESCE(NULLIF(EXCLUDED.s2  ,''), fein_meta.s2),
        updated_at  = now()
      RETURNING season, league_id, team_id, name, handle, league_size, fb_groups, swid, s2, updated_at
    `;
    const params = [
      season,
      leagueId,
      teamId,
      name || null,
      handle || null,
      leagueSize,
      Array.isArray(fb_groups) ? JSON.stringify(dedup(fb_groups)) : null,
      swid || null,
      s2 || null
    ];

    const rows = await query(sql, params).then(r => r.rows);
    return ok(res, { row: rows[0] || null });
  } catch (e) { return boom(res, e); }
});

// ---------------------------------------------------------------------------
// GET /fein-auth/creds?leagueId=... [&season=...]
router.get('/creds', async (req, res) => {
  try {
    if (WRITE_KEY) {
      const k = s(req.headers['x-fein-key'] || '').trim();
      if (!k || k !== WRITE_KEY) return res.status(401).json({ ok:false, error:'Unauthorized (bad x-fein-key)' });
    }

    const leagueId = s(req.query.leagueId || req.query.league_id || '').trim();
    const season   = s(req.query.season   || req.query.year      || '').trim();
    if (!leagueId) return bad(res, 'leagueId required');

    let sql, params;
    if (season) {
      sql = `
        SELECT swid, s2
        FROM fein_meta
        WHERE league_id = $1 AND season = $2
          AND swid IS NOT NULL AND s2 IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `;
      params = [leagueId, season];
    } else {
      sql = `
        SELECT swid, s2
        FROM fein_meta
        WHERE league_id = $1
          AND swid IS NOT NULL AND s2 IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `;
      params = [leagueId];
    }

    const rows = await query(sql, params).then(r => r.rows);
    const row = rows?.[0];
    if (!row?.swid || !row?.s2) return res.status(404).json({ ok:false, error:'no stored creds' });

    return ok(res, { swid: row.swid, s2: row.s2 });
  } catch (e) { return boom(res, e); }
});

module.exports = router;
