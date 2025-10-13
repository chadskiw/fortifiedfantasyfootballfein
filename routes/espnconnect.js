// routes/espnconnect.js
const express = require('express');
const router  = express.Router();

/* ---------- helpers ---------- */
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
function readCreds(req){
  const swid = normalizeSwid(req.body?.swid || req.query?.swid || req.cookies?.SWID || '');
  const s2   = decodePlus(req.body?.s2 || req.query?.s2 || req.cookies?.espn_s2 || '');
  return { swid, s2 };
}

/* ---------- ESPN fetchers ---------- */
async function espnLeagueFetch({ game='ffl', season, leagueId, swid, s2 }) {
  const url = new URL(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/leagues/${leagueId}`);
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
    const err = new Error(`ESPN ${r.status} ${r.statusText}`);
    err.status = r.status; err.bodySnippet = (txt||'').slice(0, 240);
    throw err;
  }
  return r.json();
}

async function espnFanFetch({ swid, s2 }) {
  const url = new URL(`https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`);
  const r = await fetch(url, {
    headers: {
      accept: 'application/json',
      cookie: `SWID=${swid}; espn_s2=${s2}`,
      referer: 'https://www.espn.com/'
    }
  });
  if (!r.ok) {
    const txt = await r.text().catch(()=> '');
    const err = new Error(`Fan ${r.status} ${r.statusText}`);
    err.status = r.status; err.bodySnippet = (txt||'').slice(0, 240);
    throw err;
  }
  return r.json();
}

/* Derive FFL leagueIds for a season from the Fan blob */
function deriveFflLeagueIdsFromFan(fanJson, season){
  const prefs = Array.isArray(fanJson?.preferences) ? fanJson.preferences : [];
  const ids = new Set();
  for (const p of prefs) {
    // Fantasy LM entries have typeId 9; football uses abbrev 'FFL'
    const entry = p?.metaData?.entry;
    if (!entry) continue;
    const isFfl = String(entry?.abbrev || '').toUpperCase() === 'FFL' || Number(entry?.gameId) === 1;
    const sameSeason = Number(entry?.seasonId) === Number(season);
    const group = Array.isArray(entry?.groups) && entry.groups[0];
    const leagueId = group?.groupId || group?.groupID || null;
    if (isFfl && sameSeason && leagueId) ids.add(String(leagueId));
  }
  return [...ids];
}

/* ---------- POST /api/espnconnect/ingest ---------- */
router.post('/ingest', async (req, res) => {
  const pool   = req.app.get('pg');
  const season = Number(req.body?.season) || new Date().getUTCFullYear();
  const { swid, s2 } = readCreds(req);
  if (!swid || !s2) return res.status(400).json({ ok:false, error:'missing_swid_or_s2' });

  // Accept several shapes
  let items = [];
  if (Array.isArray(req.body?.items)) items = req.body.items;
  else if (Array.isArray(req.body?.leagueIds)) items = req.body.leagueIds.map(id => ({ game:'ffl', leagueId:String(id) }));
  else if (Array.isArray(req.body?.leagues)) items = req.body.leagues.map(id => ({ game:'ffl', leagueId:String(id) }));
  else if (Array.isArray(req.body?.selections)) items = req.body.selections.map(id => ({ game:'ffl', leagueId:String(id) }));

  // If nothing provided, auto-derive from Fan API (football only, this season)
  if (!items.length) {
    try {
      const fan = await espnFanFetch({ swid, s2 });
      const leagueIds = deriveFflLeagueIdsFromFan(fan, season);
      items = leagueIds.map(leagueId => ({ game:'ffl', leagueId }));
    } catch (e) {
      console.error('[espnconnect/ingest fan-derive]', e.status, e.bodySnippet);
      // keep items empty; will error below
    }
  }
  if (!items.length) return res.status(400).json({ ok:false, error:'no_items_derived' });

  const results = [];
  for (const raw of items) {
    const game     = String(raw?.game || 'ffl').toLowerCase();
    const leagueId = String(raw?.leagueId || '').trim();
    if (!leagueId) { results.push({ ok:false, error:'missing_leagueId' }); continue; }
    if (game !== 'ffl') { results.push({ ok:false, leagueId, error:'unsupported_game' }); continue; }

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
          t?.pointsFor ?? t?.points ?? 0
        ) || 0;

        const up = await pool.query(`
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
        `, [season, leagueId, teamId, teamName, ownerGuid, seasonPts]);

        if (up.rows?.[0]?.inserted) inserted++; else updated++;

        // light cache (optional)
        await pool.query(`
          INSERT INTO ff_team_points_cache
            (season, league_id, team_id, team_name, scoring, week, week_pts, season_pts, updated_at)
          VALUES ($1,$2,$3,$4,'PPR',1,$5,$5,now())
          ON CONFLICT (season, league_id, team_id, scoring, week)
          DO UPDATE SET team_name=EXCLUDED.team_name,
                        week_pts=EXCLUDED.week_pts,
                        season_pts=EXCLUDED.season_pts,
                        updated_at=now()
        `, [season, leagueId, teamId, teamName, seasonPts]);
      }

      results.push({ ok:true, game, leagueId, teamCount: teams.length, inserted, updated });
    } catch (e) {
      console.error('[espnconnect/ingest league]', leagueId, e.status, e.bodySnippet);
      results.push({ ok:false, leagueId, error: e.message, status: e.status || 500 });
    }
  }

  res.set('Cache-Control','no-store');
  res.json({ ok:true, season, results });
});

module.exports = router;
