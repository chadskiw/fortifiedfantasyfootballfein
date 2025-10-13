// routes/espnconnect.js
const express = require('express');
const router  = express.Router();

/* ---------- tiny helpers ---------- */
function decodePlus(s){ try{ return decodeURIComponent(String(s||'').replace(/\+/g,'%20')); } catch { return String(s||''); } }
function normalizeSwid(raw){
  let v = decodePlus(raw||'').trim(); if (!v) return '';
  v = v.replace(/^%7B/i,'{').replace(/%7D$/i,'}');
  if (!v.startsWith('{')) v = `{${v.replace(/^\{?/, '').replace(/\}?$/, '')}}`;
  return v.toUpperCase();
}
function teamDisplayName(t) {
  return t?.teamName || t?.name || [t?.location, t?.nickname].filter(Boolean).join(' ') || t?.abbrev || String(t?.id || '');
}

/* ---------- ESPN fetch (with cookies) ---------- */
async function espnLeagueFetch({ game='ffl', season, leagueId, swid, s2 }) {
  const url = new URL(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/leagues/${leagueId}`);
  // mTeam → teams, mSettings is harmless to include
  url.searchParams.set('view', 'mTeam');
  url.searchParams.append('view', 'mSettings');

  const r = await fetch(url, {
    headers: {
      accept: 'application/json, text/plain, */*',
      cookie: `SWID=${swid}; espn_s2=${s2}`,
      referer: 'https://fantasy.espn.com/'
    }
  });
  if (!r.ok) {
    const txt = await r.text().catch(()=> '');
    const bodySnippet = (txt||'').slice(0, 240);
    const err = new Error(`ESPN ${r.status} ${r.statusText}`);
    err.status = r.status; err.bodySnippet = bodySnippet;
    throw err;
  }
  return r.json();
}

/* ---------- POST /api/espnconnect/ingest ----------

Request body (JSON):
{
  "season": 2025,
  "swid": "{...}",          // optional if cookie present
  "s2": "AEC...",           // optional if cookie present
  "items": [
    { "game": "ffl", "leagueId": "1634950747" },
    { "game": "ffl", "leagueId": "1855265329" }
  ]
}
*/
router.post('/ingest', async (req, res) => {
  const pool = req.app.get('pg');
  const season = Number(req.body?.season) || new Date().getUTCFullYear();
  const items  = Array.isArray(req.body?.items) ? req.body.items : [];

  // creds from body or cookies
  const swid = normalizeSwid(req.body?.swid || req.cookies?.SWID || '');
  const s2   = decodePlus(req.body?.s2 || req.cookies?.espn_s2 || '');
  if (!swid || !s2) return res.status(400).json({ ok:false, error:'missing_swid_or_s2' });
  if (!items.length) return res.status(400).json({ ok:false, error:'no_items' });

  const results = [];
  for (const raw of items) {
    const game     = String(raw?.game || 'ffl').toLowerCase();
    const leagueId = String(raw?.leagueId || '').trim();
    if (!leagueId) { results.push({ leagueId:null, ok:false, error:'missing_leagueId' }); continue; }
    if (game !== 'ffl') { results.push({ leagueId, ok:false, error:'unsupported_game' }); continue; } // extend later

    try {
      const league = await espnLeagueFetch({ game, season, leagueId, swid, s2 });
      const teams = Array.isArray(league?.teams) ? league.teams : [];
      let inserted = 0, updated = 0;

      for (const t of teams) {
        const teamId = Number(t?.id ?? t?.teamId);
        if (!Number.isFinite(teamId)) continue;

        const teamName  = teamDisplayName(t);
        const ownerGuid = (t?.owners && t.owners[0]) || t?.primaryOwner || t?.owner || null;
        const seasonPts = Number(
          t?.record?.overall?.pointsFor ??
          t?.pointsFor ??
          t?.points ??
          0
        ) || 0;

        const q = `
          INSERT INTO ff_sport_ffl
            (season, platform, league_id, team_id, team_name, owner_guid, season_pts, updated_at)
          VALUES ($1,'espn',$2,$3,$4,$5,$6,now())
          ON CONFLICT (season, platform, league_id, team_id)
          DO UPDATE SET
            team_name = EXCLUDED.team_name,
            owner_guid = COALESCE(EXCLUDED.owner_guid, ff_sport_ffl.owner_guid),
            season_pts = COALESCE(EXCLUDED.season_pts, ff_sport_ffl.season_pts),
            updated_at = now()
          RETURNING (xmax = 0) AS inserted
        `;
        const r = await pool.query(q, [season, leagueId, teamId, teamName, ownerGuid, seasonPts]);
        if (r.rows?.[0]?.inserted) inserted++; else updated++;

        // lightweight cache to make FEIN happy immediately (optional)
        await pool.query(`
          INSERT INTO ff_team_points_cache
            (season, league_id, team_id, team_name, scoring, week, week_pts, season_pts, updated_at)
          VALUES ($1,$2,$3,$4,'PPR',1,$5,$5,now())
          ON CONFLICT (season, league_id, team_id, scoring, week)
          DO UPDATE SET
            team_name=EXCLUDED.team_name,
            week_pts=EXCLUDED.week_pts,
            season_pts=EXCLUDED.season_pts,
            updated_at=now()
        `, [season, leagueId, teamId, teamName, seasonPts]);
      }

      results.push({ ok:true, game, leagueId, teamCount: teams.length, inserted, updated });
    } catch (e) {
      console.error('[espnconnect/ingest]', { leagueId, status: e.status, bodySnippet: e.bodySnippet });
      results.push({ ok:false, game, leagueId, error: e.message, status: e.status || 500 });
    }
  }

  res.set('Cache-Control','no-store');
  res.json({ ok:true, season, results });
});

module.exports = router;
