const express = require('express');
const router  = express.Router();

function n(v, d=0){ const x = Number(v); return Number.isFinite(x) ? x : d; }
function s(v){ return (v == null ? '' : String(v)); }

function mask(v, head=4, tail=3){
  const t = s(v); if (!t) return '';
  if (t.length <= head + tail) return t;
  return t.slice(0, head) + '…' + t.slice(-tail);
}

async function espnPlatformJson(req, path, qs = {}) {
  const url = new URL(`${req.protocol}://${req.get('host')}/api/platforms/espn/${path.replace(/^\/+/, '')}`);
  Object.entries(qs).forEach(([k,v]) => url.searchParams.set(k, String(v)));
  // forward ESPN creds if present
  const r = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-espn-swid': req.get('x-espn-swid') || req.cookies?.SWID || '',
      'x-espn-s2'  : req.get('x-espn-s2')   || req.cookies?.espn_s2 || ''
    }
  });
  if (!r.ok) throw new Error(`/api/platforms/espn/${path} → ${r.status}`);
  return r.json();
}

/**
 * POST /api/espnconnect/ingest
 * { season, leagues: [{leagueId, season?, gameAbbrev?, leagueName?, teamsCount?}] }
 * -> { ok, season, leagues, teamsUpserted }
 */
router.post('/ingest', express.json(), async (req, res) => {
  const pool   = req.app.get('pg');
  const season = n(req.body?.season);
  const leagues = Array.isArray(req.body?.leagues) ? req.body.leagues : [];

  if (!season || !leagues.length) {
    return res.status(400).json({ ok:false, error:'missing_input' });
  }

  let leaguesProcessed = 0;
  let teamsUpserted = 0;

  for (const raw of leagues) {
    const leagueId = s(raw.leagueId);
    if (!leagueId) continue;

    // Fill missing name/count from our league proxy (single call)
    let leagueName = s(raw.leagueName);
    let teamsCount = n(raw.teamsCount, 0);
    let gameAbbrev = s(raw.gameAbbrev || 'FFL').toLowerCase();

    try {
      if (!leagueName || !teamsCount) {
        const L = await espnPlatformJson(req, 'league', { season, leagueId });
        leagueName = leagueName || s(L?.leagueName || L?.settings?.name || '');
        teamsCount = teamsCount || n(L?.teams?.length, 0);
        gameAbbrev = s(L?.gameAbbrev || gameAbbrev).toLowerCase();
      }
    } catch (e) {
      // keep going — maybe private league but we can still try rostering with creds
      console.warn('[espnconnect/ingest league meta]', leagueId, e.message);
    }

    console.log('[espnconnect/ingest league]',
      leagueId, teamsCount, leagueName || '(no name)',
      mask(req.get('x-espn-swid')||''), mask(req.get('x-espn-s2')||'')
    );

    // Only support football for now
    if (!/ffl|football/i.test(gameAbbrev)) { leaguesProcessed++; continue; }

    // Pull teams (from league blob if we already have it; otherwise from league call)
    let teams = [];
    try {
      const L = await espnPlatformJson(req, 'league', { season, leagueId });
      teams = Array.isArray(L?.teams) ? L.teams : [];
    } catch (e) {
      // fall back: derive team ids from 1..teamsCount and fetch a roster just to learn team ids
      teams = Array.from({ length: Math.max(teamsCount, 0) }, (_, i) => ({ teamId: i+1 }));
    }

    // Upsert each team into ff_sport_ffl
    for (const t of teams) {
      const teamId   = n(t?.teamId ?? t?.id);
      if (!teamId) continue;
      const teamName = s(t?.teamName || t?.name || [t?.location, t?.nickname].filter(Boolean).join(' '));

      await pool.query(`
        INSERT INTO ff_sport_ffl
          (season, platform, league_id, team_id, team_name, updated_at)
        VALUES ($1,'espn',$2,$3,$4,now())
        ON CONFLICT (season, platform, league_id, team_id)
        DO UPDATE SET team_name=EXCLUDED.team_name, updated_at=now()
      `, [season, leagueId, teamId, teamName]);

      teamsUpserted++;
    }

    leaguesProcessed++;
  }

  res.json({ ok:true, season, leagues: leaguesProcessed, teamsUpserted });
});

module.exports = router;
