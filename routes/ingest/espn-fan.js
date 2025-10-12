// routes/ingest/espn-fan.js
const express = require('express');
const router  = express.Router();

/* ------------------------ helpers ------------------------ */
function absoluteOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('x-forwarded-host')  || req.get('host');
  return host ? `${proto}://${host}` : 'https://fortifiedfantasy.com';
}

// Pull creds from headers, then query, then body
function getEspnCreds(req) {
  const q = req.query || {};
  const b = req.body || {};
  const swid = (req.headers['x-espn-swid'] || q.swid || q.SWID || b.swid || '').toString();
  const s2   = (req.headers['x-espn-s2']   || q.s2   || q.S2   || b.s2   || '').toString();
  return { swid, s2 };
}

// Always pass the creds through to the internal ESPN proxy
async function espnGet(req, path, qs = {}) {
  const origin = absoluteOrigin(req);
  const clean  = String(path).replace(/^\/+/, '');
  const url    = new URL(`${origin}/api/platforms/espn/${clean}`);
  Object.entries(qs).forEach(([k,v]) => url.searchParams.set(k, String(v)));
  url.searchParams.set('_t', Date.now()); // cache-bust

  const { swid, s2 } = getEspnCreds(req);
  const headers = {
    'accept'        : 'application/json',
    'cache-control' : 'no-cache',
    'x-espn-swid'   : swid || '',
    'x-espn-s2'     : s2   || ''
  };

  const r = await fetch(url.toString(), { headers });
  if (r.status === 304) return {};
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

function getLeagueIdsFromPoll(poll) {
  if (Array.isArray(poll?.data))
    return [...new Set(poll.data.map(x => String(x.leagueId || x.league_id)).filter(Boolean))];
  if (Array.isArray(poll?.leagues))
    return [...new Set(poll.leagues.map(x => String(x)).filter(Boolean))];
  if (Array.isArray(poll))
    return [...new Set(poll.map(x => String(x.leagueId || x.league_id)).filter(Boolean))];
  return [];
}

// ESPN -> our short game code
function mapGameFromLeague(league) {
  const raw = (
    league?.gameAbbrev || league?.game || league?.sportKey || league?.sport ||
    league?.abbrev || league?.metaData?.entry?.abbrev
  ) || '';
  const s = String(raw).toLowerCase();
  if (s.includes('ffl') || s.includes('football')) return 'ffl';
  if (s.includes('flb') || s.includes('baseball')) return 'flb';
  if (s.includes('fhl') || s.includes('hockey'))   return 'fhl';
  if (s.includes('fba') || s.includes('basket'))   return 'fba';
  if (s.includes('fwnba')|| s.includes('wnba'))    return 'fwnba';
  return 'ffl'; // default safe
}

// map ESPN scoring labels to table column (STD/HALF/PPR)
function mapScoring(league) {
  const raw = (
    league?.scoringTypeName || league?.scoringType ||
    league?.settings?.scoringType || ''
  ).toString().toUpperCase();
  if (raw.includes('HALF')) return 'HALF';
  if (raw.includes('PPR'))  return 'PPR';
  return 'STD';
}

// best-effort pull of “season starters” for a team; safe to fail
async function tryGetSeasonStarters(req, season, leagueId, teamId) {
  try {
    const roster = await espnGet(req, 'roster', { season, leagueId, teamId, scope: 'season' });
    const items = Array.isArray(roster?.starters) ? roster.starters : Array.isArray(roster) ? roster : [];
    return items.map(x => ({
      id: x.id ?? x.playerId ?? null,
      name: x.name ?? x.playerName ?? x.fullName ?? null,
      slot: x.slot ?? x.lineupSlot ?? x.position ?? null,
      team: x.team ?? x.proTeamAbbrev ?? null,
      position: x.position ?? x.primaryPos ?? null,
      pts: Number(x.pts ?? x.fantasyPoints ?? 0) || 0,
      fpId: x.fpId ?? x.fantasyPlayerId ?? null,
    }));
  } catch {
    return null;
  }
}

// Synthesize a record JSON if not provided
function buildTeamRecord(t) {
  if (t?.record && typeof t.record === 'object')  return t.record;
  if (t?.records && typeof t.records === 'object') return t.records;

  const wins   = Number(t?.wins   ?? t?.record?.wins   ?? 0) || 0;
  const losses = Number(t?.losses ?? t?.record?.losses ?? 0) || 0;
  const ties   = Number(t?.ties   ?? t?.record?.ties   ?? 0) || 0;
  const pointsFor     = Number(t?.pointsFor ?? t?.points ?? 0) || 0;
  const pointsAgainst = Number(t?.pointsAgainst ?? 0) || 0;
  const percentage = (wins + losses + ties) ? wins / (wins + losses + ties) : 0;

  const overall = {
    wins, losses, ties,
    gamesBack: 0,
    pointsFor, pointsAgainst,
    percentage,
    streakType: 'NONE',
    streakLength: 0
  };
  return { overall, home: overall, away: overall, division: overall };
}

// UPSERT journal to ff_espn_fan
async function journalFan(pool, { swid, s2, payload }) {
  try {
    await pool.query(
      `INSERT INTO ff_espn_fan (swid, espn_s2, raw, updated_at)
       VALUES ($1,$2,$3::jsonb, now())
       ON CONFLICT (swid) DO UPDATE
         SET espn_s2   = EXCLUDED.espn_s2,
             raw       = EXCLUDED.raw,
             updated_at= now()`,
      [ swid || '', s2 || '', JSON.stringify(payload) ]
    );
  } catch (e) {
    console.warn('[journalFan] non-fatal:', e.message || e);
  }
}
/* ---------------------- end helpers ---------------------- */

/* ======================= /season ======================== */
router.post('/season', async (req, res) => {
  const pool   = req.app.get('pg');
  const season = Number(req.body?.season || req.query?.season || new Date().getUTCFullYear());
  if (!Number.isFinite(season)) return res.status(400).json({ ok:false, error:'season required' });

  const { swid, s2 } = getEspnCreds(req);

  try {
    // 1) poll (+ journal once)
    const poll = await espnGet(req, 'poll', { season, scope: 'season' });
    await journalFan(pool, { swid, s2, payload: { kind:'poll', season, payload: poll } });

    const leagueIds = getLeagueIdsFromPoll(poll);
    if (!leagueIds.length) {
      return res.json({ ok:true, season, leaguesCount: 0 });
    }

    // 2) hydrate each league and write
    for (const leagueId of leagueIds) {
      const league = await espnGet(req, 'league', { season, leagueId });
      await journalFan(pool, { swid, s2, payload: { kind:'league', season, leagueId, payload: league } });

      const game         = mapGameFromLeague(league);
      const leagueName   = league?.name || league?.leagueName || league?.groupName || '';
      const scoring_type = (league?.scoringTypeName || league?.scoringType || league?.settings?.scoringType || 'H2H')
                            .toString().toUpperCase();

      // ---- ff_league (UPSERT) ----
      await pool.query(`
        INSERT INTO ff_league (platform, league_id, season, name, scoring_type, game, updated_at)
        VALUES ('espn', $1, $2, $3, $4, $5, now())
        ON CONFLICT (platform, league_id, season)
        DO UPDATE SET name         = EXCLUDED.name,
                      scoring_type = EXCLUDED.scoring_type,
                      game         = EXCLUDED.game,
                      updated_at   = now()
      `, [leagueId, season, leagueName, scoring_type, game]);

      // -------- teams / owners / season totals (week=1) --------
      const teams = Array.isArray(league?.teams) ? league.teams : [];
      for (const t of teams) {
        const teamId   = Number(t.teamId ?? t.id);
        if (!Number.isFinite(teamId)) continue;

const teamName =
  t.teamName ||
  t.name ||
  [t.location, t.nickname].filter(Boolean).join(' ') ||
  t.team?.nickname ||
  t.abbrev ||
  `Team ${teamId}`;
        let pf       = Number(t.pointsFor ?? t.points ?? 0) || 0;

        const logo       = t.logo || t.teamLogoUrl || null;
        const recordJson = buildTeamRecord(t);
        const ownerGuid  = t.ownerGuid || t.memberGuid || t.memberId || null;

        // ---- ff_team (UPSERT) ----
        await pool.query(`
          INSERT INTO ff_team
            (platform, season, league_id, team_id, name, logo, record, owner_guid, game, updated_at)
          VALUES
            ('espn', $1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())
          ON CONFLICT (platform, season, league_id, team_id)
          DO UPDATE SET name       = EXCLUDED.name,
                        logo       = EXCLUDED.logo,
                        record     = EXCLUDED.record,
                        owner_guid = COALESCE(EXCLUDED.owner_guid, ff_team.owner_guid),
                        game       = EXCLUDED.game,
                        updated_at = now()
        `, [season, leagueId, teamId, teamName, logo, JSON.stringify(recordJson), ownerGuid, game]);

        // ---- ff_team_owner (update-then-insert; schema has no owner_handle) ----
        try {
          if (ownerGuid) {
            const updOwner = await pool.query(`
              UPDATE ff_team_owner
                 SET member_id        = COALESCE($5, member_id),
                     owner_kind       = 'real',
                     espn_owner_guids = ARRAY[$5]::text[],
                     updated_at       = now()
               WHERE platform = 'espn'
                 AND season   = $1
                 AND league_id= $2
                 AND team_id  = $3
            `, [season, leagueId, teamId, 'espn', String(ownerGuid)]);
            if (updOwner.rowCount === 0) {
              await pool.query(`
                INSERT INTO ff_team_owner
                  (platform, season, league_id, team_id, member_id, owner_kind, espn_owner_guids, updated_at)
                VALUES
                  ('espn', $1, $2, $3, $4, 'real', ARRAY[$4]::text[], now())
              `, [season, leagueId, teamId, String(ownerGuid)]);
            }
          }
        } catch (e) {
          console.warn('[ff_team_owner] non-fatal:', e.message || e);
        }

        // ---- ff_team_weekly_points (week=1 totals; include team_name/scoring/starters) ----
        const week     = 1; // season totals live at week=1 for your schema
        const scoring  = mapScoring(league);
        const starters = await tryGetSeasonStarters(req, season, leagueId, teamId);
        const startersJson = starters ? JSON.stringify(starters) : null;
// before: const pf = Number(t.pointsFor ?? t.points ?? 0) || 0;
pf = Number(t.pointsFor ?? t.points ?? 0);
if (!Number.isFinite(pf) || pf <= 0) {
  // use starters if present
  if (Array.isArray(starters) && starters.length) {
    pf = starters.reduce((s, x) => s + (Number(x.pts) || 0), 0);
  } else {
    pf = 0;
  }
}

        // Update-if-exists, else insert (key includes scoring)
        const updWk = await pool.query(`
          UPDATE ff_team_weekly_points
             SET team_name = $5,
                 points    = $6,
                 starters  = $7::jsonb,
                 scoring   = $8,
                 updated_at= now()
           WHERE season    = $1
             AND league_id = $2
             AND team_id   = $3
             AND week      = $4
             AND scoring   = $8
        `, [season, leagueId, teamId, week, teamName, pf, startersJson, scoring]);

        if (updWk.rowCount === 0) {
          await pool.query(`
            INSERT INTO ff_team_weekly_points
              (season, league_id, team_id, week, team_name, points, starters, scoring, created_at, updated_at)
            VALUES
              ($1,     $2,       $3,      $4,   $5,        $6,     $7::jsonb, $8,      now(),     now())
          `, [season, leagueId, teamId, week, teamName, pf, startersJson, scoring]);
        }

        // ---- ff_team_points_cache: mirror week=1 totals (upsert on PK: season, league_id, team_id, scoring, week)
        // First try to update the existing cache row; if none, insert it.
        const updCache = await pool.query(`
          UPDATE ff_team_points_cache
             SET team_name  = $6,
                 week_pts   = $7,
                 season_pts = $7,   -- season total equals week=1 totals
                 updated_at = now()
           WHERE season    = $1
             AND league_id = $2
             AND team_id   = $3
             AND scoring   = $4
             AND week      = $5
        `, [season, leagueId, teamId, scoring, week, teamName, pf]);

        if (updCache.rowCount === 0) {
          await pool.query(`
            INSERT INTO ff_team_points_cache
              (season, league_id, team_id, scoring, week, team_name, week_pts, season_pts, updated_at)
            VALUES
              ($1,     $2,       $3,      $4,      $5,   $6,        $7,       $7,         now())
          `, [season, leagueId, teamId, scoring, week, teamName, pf]);
        }
      } // teams
    } // leagues

    return res.json({ ok:true, season, leaguesCount: leagueIds.length });
  } catch (e) {
    console.error('[ingest/fan]', e);
    return res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

module.exports = router;
