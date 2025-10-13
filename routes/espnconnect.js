// routes/espnconnect.js
const express = require('express');
const router  = express.Router();

/* ---------------- helpers ---------------- */
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
  let swid = normalizeSwid(req.body?.swid || req.query?.swid || req.cookies?.SWID || '');
  let s2   = decodePlus(req.body?.s2 || req.query?.s2 || req.cookies?.espn_s2 || '');
  // fallback: parse from Referer (your page has ?swid=...&s2=...)
  if ((!swid || !s2) && req.get('referer')) {
    try {
      const u = new URL(req.get('referer'));
      swid = swid || normalizeSwid(u.searchParams.get('swid') || u.searchParams.get('SWID'));
      s2   = s2   || decodePlus(u.searchParams.get('s2')   || u.searchParams.get('espn_s2'));
    } catch {}
  }
  return { swid, s2 };
}

/* --------------- ESPN fetchers --------------- */
async function espnLeagueFetch({ game='ffl', season, leagueId, swid, s2 }) {
  if (!swid || !s2) {
    const err = new Error('missing_creds');
    err.status = 400;
    throw err;
  }
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

/* optional: Fan API (used only for auto-derive if you send no items) */
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
function deriveFflLeagueIdsFromFan(fanJson, season){
  const prefs = Array.isArray(fanJson?.preferences) ? fanJson.preferences : [];
  const ids = new Set();
  for (const p of prefs) {
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

/* -------- POST /api/espnconnect/ingest -------- */
router.post('/ingest', async (req, res) => {
  const pool   = req.app.get('pg');
  const season = Number(req.body?.season) || new Date().getUTCFullYear();
  const { swid, s2 } = readCreds(req);

  // collect requested leagues
  let items = [];
  if (Array.isArray(req.body?.items)) items = req.body.items;
  else if (Array.isArray(req.body?.leagueIds)) items = req.body.leagueIds.map(id => ({ game:'ffl', leagueId:String(id) }));
  else if (Array.isArray(req.body?.selections)) items = req.body.selections.map(id => ({ game:'ffl', leagueId:String(id) }));

  // if nothing provided, derive football leagues for that season
  if (!items.length && swid && s2) {
    try {
      const fan = await espnFanFetch({ swid, s2 });
      const leagueIds = deriveFflLeagueIdsFromFan(fan, season);
      items = leagueIds.map(leagueId => ({ game:'ffl', leagueId }));
    } catch (e) {
      // ignore, handled below
    }
  }
  if (!items.length) return res.status(400).json({ ok:false, error:'no_items_derived_or_provided' });

  const results = [];
  let leaguesSucceeded = 0, teamsInserted = 0, teamsUpdated = 0, teamsTotal = 0;

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
        const seasonPts = Number(t?.record?.overall?.pointsFor ?? t?.pointsFor ?? t?.points ?? 0) || 0;

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
      }

      leaguesSucceeded++;
      teamsInserted += inserted;
      teamsUpdated  += updated;
      teamsTotal    += (inserted + updated);

      results.push({ ok:true, game, leagueId, teamCount: teams.length, inserted, updated });
    } catch (e) {
      console.error('[espnconnect/ingest league]', leagueId, e?.status ?? 0, e?.bodySnippet);
      results.push({ ok:false, leagueId, error: e.message, status: e.status || 500 });
    }
  }

  res.set('Cache-Control','no-store');
  res.json({
    ok: true,
    season,
    summary: {
      leaguesAttempted: items.length,
      leaguesSucceeded,
      teamsInserted,
      teamsUpdated,
      teamsTotal
    },
    results
  });
});

module.exports = router;
