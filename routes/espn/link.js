// routes/espn/link.js
const express = require('express');
const router  = express.Router();

/* --------------------- tiny helpers --------------------- */
function decodePlus(s){ try{ return decodeURIComponent(String(s||'').replace(/\+/g,'%20')); } catch { return String(s||''); } }
function normalizeSwid(raw){
  let v = decodePlus(raw||'').trim(); if (!v) return '';
  v = v.replace(/^%7B/i,'{').replace(/%7D$/i,'}');
  if (!v.startsWith('{')) v = `{${v.replace(/^\{?/, '').replace(/\}?$/, '')}}`;
  return v.toUpperCase();
}
function absoluteOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('x-forwarded-host')  || req.get('host');
  return host ? `${proto}://${host}` : 'https://fortifiedfantasy.com';
}
function setCredCookies(req, res, swid, s2) {
  const oneYear = 31536000000;
  const opts = { httpOnly:false, sameSite:'Lax', secure:true, maxAge:oneYear, domain:'fortifiedfantasy.com', path:'/' };
  if (swid) res.cookie('SWID',    swid, opts);
  if (s2)   res.cookie('espn_s2', s2,   opts);
}

/* --------------- minimal ESPN proxy calls --------------- */
async function espnFetch(req, path, qs = {}) {
  const origin = absoluteOrigin(req);
  const url = new URL(`${origin}/api/platforms/espn/${path.replace(/^\/+/, '')}`);
  Object.entries(qs).forEach(([k,v]) => { if (v!==undefined && v!==null) url.searchParams.set(k, String(v)); });
  url.searchParams.set('_t', Date.now());
  const headers = {
    'accept': 'application/json',
    'x-espn-swid': req._link.swid || req.cookies?.SWID || '',
    'x-espn-s2'  : req._link.s2   || req.cookies?.espn_s2 || '',
  };
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`[${path}] ${r.status} ${r.statusText}`);
  return r.json();
}

function teamDisplayName(t) {
  return t?.teamName || t?.name || [t?.location, t?.nickname].filter(Boolean).join(' ') || t?.abbrev || '';
}

/* If league blob doesn’t have pointsFor, derive from season roster starters */
async function deriveSeasonPoints(req, season, leagueId, teamId) {
  try {
    const roster = await espnFetch(req, 'roster', { season, leagueId, teamId, scope:'season' });
    const starters = Array.isArray(roster?.starters) ? roster.starters : Array.isArray(roster) ? roster : [];
    return starters.reduce((s,x)=> s + (Number(x?.pts ?? x?.fantasyPoints ?? 0) || 0), 0);
  } catch { return 0; }
}

/* --------------------- the /link route ------------------- */
/**
 * GET /api/espn/link?swid={...}&s2=...&season=2025&to=/fein/index.html?season=2025&games=ffl
 * Easiest path: ingest leagues/teams straight into ff_sport_ffl (and cache) then redirect.
 */
router.get('/link', async (req, res) => {
  const pool   = req.app.get('pg');      // pg.Pool set on app
  const season = Number(req.query.season) || new Date().getUTCFullYear();
  const games  = String(req.query.games || 'ffl').toLowerCase();
  const to     = String(req.query.to || `${absoluteOrigin(req)}/fein/index.html?season=${season}`);

  // Normalize creds straight from the URL (as requested) and keep on req._link
  const swid = normalizeSwid(req.query.swid || req.query.SWID || '');
  const s2   = decodePlus(req.query.s2 || req.query.espn_s2 || req.query.ESPN_S2 || '');
  req._link = { swid, s2 };

  // Make them available to browser too (optional but harmless)
  setCredCookies(req, res, swid, s2);

  try {
    // 1) Find all leagues for this season
    const poll = await espnFetch(req, 'poll', { season });
    const leagueIds = Array.isArray(poll?.leagues) ? [...new Set(poll.leagues.map(String))]
                     : Array.isArray(poll?.data)    ? [...new Set(poll.data.map(x=>String(x.leagueId||x.league_id)).filter(Boolean))]
                     : Array.isArray(poll)          ? [...new Set(poll.map(x=>String(x.leagueId||x.league_id)).filter(Boolean))]
                     : [];
    // If user only wants football right now, we’ll still read all, but only WRITE ffl teams
    // (simplest: filter by league.gameAbbrev later)

    // 2) For each league, fetch teams and write rows
    for (const leagueId of leagueIds) {
      const league = await espnFetch(req, 'league', { season, leagueId });
      const gameAbbrev = String(league?.gameAbbrev || league?.game || '').toLowerCase();
      const isFFL = gameAbbrev.includes('ffl') || gameAbbrev.includes('football');
      if (games === 'ffl' && !isFFL) continue;

      const teams = Array.isArray(league?.teams) ? league.teams : [];
      for (const t of teams) {
        const teamId = Number(t.teamId ?? t.id);
        if (!Number.isFinite(teamId)) continue;

        const teamName = teamDisplayName(t);
        let seasonPts = Number(t?.record?.overall?.pointsFor ?? t?.pointsFor ?? t?.points ?? 0) || 0;
        if (!seasonPts) {
          // derive from roster if league blob didn’t have PF
          seasonPts = await deriveSeasonPoints(req, season, leagueId, teamId);
        }
        const ownerGuid = t.ownerGuid || t.memberGuid || t.memberId || null;

        // 2a) Upsert into ff_sport_ffl (final table you asked for)
        // Adjust column names if your schema differs; this is intentionally minimal.
        await pool.query(`
          INSERT INTO ff_sport_ffl
            (season, platform, league_id, team_id, team_name, owner_guid, season_pts, updated_at)
          VALUES ($1, 'espn', $2, $3, $4, $5, $6, now())
          ON CONFLICT (season, platform, league_id, team_id)
          DO UPDATE SET team_name=EXCLUDED.team_name,
                        owner_guid=COALESCE(EXCLUDED.owner_guid, ff_sport_ffl.owner_guid),
                        season_pts=EXCLUDED.season_pts,
                        updated_at=now()
        `, [season, leagueId, teamId, teamName, ownerGuid, seasonPts]);

        // 2b) (Optional but helps FEIN immediately) write to the cache your FE reads
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
    }

    // Done — send them to FEIN
    return res.redirect(302, to);
  } catch (e) {
    console.error('[espn/link ingest]', e);
    // Fail-soft: still go to FE so the user isn’t stuck
    return res.redirect(302, to);
  }
});

module.exports = router;
