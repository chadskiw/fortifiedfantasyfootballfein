const express = require('express');
const { q } = require('../src/db');
const { readAuthFromRequest } = require('../auth');

const router = express.Router();
const WRITE_KEY = (process.env.FEIN_AUTH_KEY || '').trim();

// GET /by-league?season=2025&size=12[&leagueId=...]
router.get('/by-league', async (req, res) => {
  try {
    const season = String(req.query.season || '').trim();
    const size = Number(req.query.size || '');
    const leagueId = String(req.query.leagueId || '').trim();
    if (!season) return res.status(400).json({ ok:false, error:'season required' });
    if (!Number.isFinite(size)) return res.status(400).json({ ok:false, error:'size required' });

    const params = [season, size];
    let sql = `
      select season, league_id, team_id, name as team_name, handle,
             league_size, fb_groups, updated_at
      from fein_meta
      where season = $1 and league_size = $2
    `;
    if (leagueId){ sql += ` and league_id = $3`; params.push(leagueId); }
    sql += ` order by league_id, team_id`;

    const rows = await q(sql, params);
    return res.json({ ok:true, count: rows.length, rows });
  } catch (e) { res.status(500).json({ ok:false, error: String(e.message || e) }); }
});

// GET /pool?size=12[&season=2025]
router.get('/pool', async (req, res) => {
  try {
    const size = Number(req.query.size || '');
    const season = String(req.query.season || '').trim();
    if (!Number.isFinite(size)) return res.status(400).json({ ok:false, error:'size required' });

    const params = [size];
    let sql = `
      select season, league_id, team_id, name as team_name, handle,
             league_size, fb_groups, updated_at
      from fein_meta
      where league_size = $1
    `;
    if (season){ sql += ` and season = $2`; params.push(season); }
    sql += ` order by season desc, league_id, team_id`;

    const rows = await q(sql, params);
    return res.json({ ok:true, count: rows.length, rows });
  } catch (e) { res.status(500).json({ ok:false, error: String(e.message || e) }); }
});

// POST /upsert-meta   (requires x-fein-key if FEIN_AUTH_KEY is set)
router.post('/upsert-meta', async (req, res) => {
  try {
    if (WRITE_KEY) {
      const k = String(req.headers['x-fein-key'] || '').trim();
      if (!k || k !== WRITE_KEY) return res.status(401).json({ ok:false, error:'Unauthorized (bad x-fein-key)' });
    }

    const b = req.body || {};
    const s = v => (v == null ? '' : String(v));
    const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
    const dedup = arr => Array.from(new Set((arr || []).flat().map(x => s(x).trim()).filter(Boolean)));

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
      const fromReq = readAuthFromRequest(req);
      if (!swid) swid = fromReq.swid || '';
      if (!s2)   s2   = fromReq.s2   || '';
    }

    if (!leagueId || !teamId || !season)
      return res.status(400).json({ ok:false, error:'leagueId, teamId, season required' });

    const sql = `
      insert into fein_meta (season, league_id, team_id, name, handle, league_size, fb_groups, swid, s2, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
      on conflict (season, league_id, team_id)
      do update set
        name        = coalesce(excluded.name, fein_meta.name),
        league_size = coalesce(excluded.league_size, fein_meta.league_size),
        handle      = coalesce(nullif(excluded.handle,''), fein_meta.handle),
        fb_groups   = case
                        when excluded.fb_groups is not null and jsonb_array_length(excluded.fb_groups) > 0
                          then (
                            select jsonb_agg(distinct x)
                            from jsonb_array_elements(coalesce(fein_meta.fb_groups,'[]'::jsonb) || excluded.fb_groups) t(x)
                          )
                        else fein_meta.fb_groups
                      end,
        swid        = coalesce(nullif(excluded.swid,''), fein_meta.swid),
        s2          = coalesce(nullif(excluded.s2  ,''), fein_meta.s2),
        updated_at  = now()
      returning season, league_id, team_id, name, handle, league_size, fb_groups, swid, s2, updated_at
    `;
    const params = [
      season, leagueId, teamId, name || null, handle || null,
      leagueSize, Array.isArray(fb_groups) ? JSON.stringify(dedup(fb_groups)) : null,
      swid || null, s2 || null
    ];

    const rows = await q(sql, params);
    return res.json({ ok:true, row: rows[0] || null });
  } catch (e) { res.status(500).json({ ok:false, error: String(e.message || e) }); }
});

// GET /creds?leagueId=... [&season=...]
router.get('/creds', async (req, res) => {
  try {
    if (WRITE_KEY) {
      const k = String(req.headers['x-fein-key'] || '').trim();
      if (!k || k !== WRITE_KEY) return res.status(401).json({ ok:false, error:'Unauthorized (bad x-fein-key)' });
    }
    const leagueId = String(req.query.leagueId || req.query.league_id || '').trim();
    const season   = String(req.query.season || req.query.year || '').trim();
    if (!leagueId) return res.status(400).json({ ok:false, error:'leagueId required' });

    let rows;
    if (season) {
      rows = await q(
        `select swid, s2 from fein_meta
         where league_id = $1 and season = $2 and swid is not null and s2 is not null
         order by updated_at desc limit 1`, [leagueId, season]
      );
    } else {
      rows = await q(
        `select swid, s2 from fein_meta
         where league_id = $1 and swid is not null and s2 is not null
         order by updated_at desc limit 1`, [leagueId]
      );
    }
    const row = rows?.[0];
    if (!row?.swid || !row?.s2) return res.status(404).json({ ok:false, error:'no stored creds' });
    return res.json({ ok:true, swid: row.swid, s2: row.s2 });
  } catch (e) { res.status(500).json({ ok:false, error: String(e.message || e) }); }
});

module.exports = router;
