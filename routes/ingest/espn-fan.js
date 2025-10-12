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

async function espnGet(req, path, qs = {}) {
  const origin = absoluteOrigin(req);
  const clean  = String(path).replace(/^\/+/, '');
  const url    = new URL(`${origin}/api/platforms/espn/${clean}`);
  Object.entries(qs).forEach(([k,v]) => url.searchParams.set(k, String(v)));
  url.searchParams.set('_t', Date.now()); // cache-bust

  const headers = {
    'accept'        : 'application/json',
    'cache-control' : 'no-cache',
    'x-espn-swid'   : req.headers['x-espn-swid'] || '',
    'x-espn-s2'     : req.headers['x-espn-s2']   || ''
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

// UPSERT journal to ff_espn_fan
async function journalFan(pool, { swid, s2, payload }) {
  try {
    await pool.query(
      `INSERT INTO ff_espn_fan (swid, espn_s2, raw, updated_at)
       VALUES ($1,$2,$3::jsonb, now())
       ON CONFLICT (swid) DO UPDATE
         SET espn_s2 = EXCLUDED.espn_s2,
             raw     = EXCLUDED.raw,
             updated_at = now()`,
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

  try {
    // 1) poll (+ journal once)
    const poll = await espnGet(req, 'poll', { season });
    await journalFan(pool, {
      swid: req.headers['x-espn-swid'],
      s2  : req.headers['x-espn-s2'],
      payload: { kind:'poll', season, payload: poll }
    });

    const leagueIds = getLeagueIdsFromPoll(poll);
    if (!leagueIds.length) {
      return res.json({ ok:true, season, leaguesCount: 0 });
    }

    // 2) hydrate each league and UPSERT team-related tables
    for (const leagueId of leagueIds) {
      const league = await espnGet(req, 'league', { season, leagueId });

      await journalFan(pool, {
        swid: req.headers['x-espn-swid'],
        s2  : req.headers['x-espn-s2'],
        payload: { kind:'league', season, leagueId, payload: league }
      });

      // -------- teams / owners / season totals (week=1) --------
      const teams = Array.isArray(league?.teams) ? league.teams : [];
      for (const t of teams) {
        const teamId   = Number(t.teamId ?? t.id);
        if (!Number.isFinite(teamId)) continue;

        const teamName = t.teamName || t.name || '';
        const ownerId  = t.memberId ?? null;
        const ownerHdl = t.ownerHandle || t.owner || null;

        const pf    = Number(t.pointsFor ?? t.points ?? 0) || 0;
        const wins  = Number(t.wins   ?? t.record?.wins   ?? 0) || 0;
        const losses= Number(t.losses ?? t.record?.losses ?? 0) || 0;
        const ties  = Number(t.ties   ?? t.record?.ties   ?? 0) || 0;

// ff_team UPSERT (matches your schema)
const logo   = t.logo || t.teamLogoUrl || null;
const record = `${wins}-${losses}${ties ? `-${ties}` : ''}`;
const game   = 'ffl'; // you said FFL is the template

await pool.query(`
  INSERT INTO ff_team (platform, season, league_id, team_id, name, logo, record, owner_guid, game, updated_at)
  VALUES ('espn', $1, $2, $3, $4, $5, $6, $7, $8, now())
  ON CONFLICT (platform, season, league_id, team_id)
  DO UPDATE SET name       = EXCLUDED.name,
                logo       = EXCLUDED.logo,
                record     = EXCLUDED.record,
                owner_guid = COALESCE(EXCLUDED.owner_guid, ff_team.owner_guid),
                game       = EXCLUDED.game,
                updated_at = now()
`, [season, leagueId, teamId, teamName, logo, record, ownerId || null, game]);


        // ff_team_owner UPSERT
// ff_team_owner (best effort; don't block ingest if schema differs)
try {
  await pool.query(`
    INSERT INTO ff_team_owner (league_id, team_id, member_id, owner_handle, updated_at)
    VALUES ($1,$2,$3,$4,now())
    ON CONFLICT (league_id, team_id)
    DO UPDATE SET member_id   = COALESCE(EXCLUDED.member_id, ff_team_owner.member_id),
                  owner_handle= COALESCE(EXCLUDED.owner_handle, ff_team_owner.owner_handle),
                  updated_at  = now()
  `, [leagueId, teamId, ownerId, ownerHdl]);
} catch (e) {
  console.warn('[ff_team_owner] non-fatal:', e.message || e);
}


        // ff_team_weekly_points (week=1 as season totals) UPSERT
        await pool.query(`
          INSERT INTO ff_team_weekly_points (season, league_id, team_id, week, points, wins, losses, ties, updated_at)
          VALUES ($1,$2,$3, 1, $4,$5,$6,$7, now())
          ON CONFLICT (season, league_id, team_id, week)
          DO UPDATE SET points=EXCLUDED.points, wins=EXCLUDED.wins, losses=EXCLUDED.losses, ties=EXCLUDED.ties, updated_at=now()
        `, [season, leagueId, teamId, pf, wins, losses, ties]);
      }

      // ff_team_points_cache UPSERT (INSERT…SELECT)
      await pool.query(`
        INSERT INTO ff_team_points_cache (season, league_id, team_id, season_points, updated_at)
        SELECT season, league_id, team_id, points, now()
          FROM ff_team_weekly_points
         WHERE season=$1 AND league_id=$2 AND week=1
        ON CONFLICT (season, league_id, team_id)
        DO UPDATE SET season_points = EXCLUDED.season_points,
                      updated_at    = now()
      `, [season, leagueId]);
    }

    return res.json({ ok:true, season, leaguesCount: leagueIds.length });
  } catch (e) {
    console.error('[ingest/fan]', e);
    return res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

module.exports = router;
