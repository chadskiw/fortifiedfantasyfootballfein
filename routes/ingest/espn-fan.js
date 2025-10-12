// routes/ingest/espn-fan.js
const express = require('express');
const router  = express.Router();
// put near top of routes/ingest/espn-fan.js
function absoluteOrigin(req) {
  // 1) allow override in env (Render/CF friendly)
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN;

  // 2) try forwarded proto + host
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('x-forwarded-host')  || req.get('host');
  if (host) return `${proto}://${host}`;

  // 3) final fallback (your real host)
  return 'https://fortifiedfantasy.com';
}

// replace your espnGet with this
async function espnGet(req, path, qs = {}) {
  const origin = absoluteOrigin(req);
  const clean  = String(path).replace(/^\/+/, ''); // no leading slash
  const url    = new URL(`${origin}/api/platforms/espn/${clean}`);
  Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const headers = {
    'accept'      : 'application/json',
    'x-espn-swid' : req.headers['x-espn-swid'] || '',
    'x-espn-s2'   : req.headers['x-espn-s2']   || '',
  };

  // Node 18+ has global fetch. If not, require('node-fetch')
  const res = await fetch(url.toString(), { method: 'GET', headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}


router.post('/season', async (req, res) => {
  const pool   = req.app.get('pg');
  const season = Number(req.body?.season || req.query?.season || new Date().getUTCFullYear());
  if (!Number.isFinite(season)) return res.status(400).json({ ok:false, error:'season required' });

  try {
    const poll = await espnGet(req, 'poll', { season });

    const leagueIds = (() => {
      if (Array.isArray(poll?.data)) return [...new Set(poll.data.map(x => String(x.leagueId || x.league_id)).filter(Boolean))];
      if (Array.isArray(poll?.leagues)) return [...new Set(poll.leagues.map(x => String(x)).filter(Boolean))];
      if (Array.isArray(poll)) return [...new Set(poll.map(x => String(x.leagueId || x.league_id)).filter(Boolean))];
      return [];
    })();

    if (!leagueIds.length) return res.json({ ok:true, season, leaguesCount: 0 });

    for (const leagueId of leagueIds) {
      const league = await espnGet(req, 'league', { season, leagueId });

    for (const leagueId of leagues) {
      // 2) league meta + teams (mTeam + mSettings)
      const league = await espnGet(req.app, 'league', { season, leagueId });

      // raw snapshot
      await pool.query(`
        INSERT INTO ff_espn_fan (season, league_id, kind, payload)
        VALUES ($1,$2,'league',$3::jsonb)
        ON CONFLICT DO NOTHING
      `, [season, leagueId, league]);

      // 3) upsert league
      await pool.query(`
        INSERT INTO ff_league (season, league_id, name, size, updated_at)
        VALUES ($1,$2,$3,$4, now())
        ON CONFLICT (season, league_id)
        DO UPDATE SET name=EXCLUDED.name, size=EXCLUDED.size, updated_at=now()
      `, [season, leagueId, league.name, league.size]);

      // 4) teams, owners, season totals -> week=1
      for (const t of league.teams || []) {
        const teamId     = Number(t.teamId);
        const teamName   = t.teamName || t.name || '';
        const ownerId    = t.memberId || null;
        const ownerHdl   = t.ownerHandle || t.owner || null;
        const pf         = Number(t.pointsFor||0);
        const wins       = Number(t.wins||0), losses = Number(t.losses||0), ties = Number(t.ties||0);

        await pool.query(`
          INSERT INTO ff_team (league_id, team_id, team_name, updated_at)
          VALUES ($1,$2,$3,now())
          ON CONFLICT (league_id, team_id)
          DO UPDATE SET team_name=EXCLUDED.team_name, updated_at=now()
        `, [leagueId, teamId, teamName]);

        // optional: track owner mapping if you use ff_team_owner
        await pool.query(`
          INSERT INTO ff_team_owner (league_id, team_id, member_id, owner_handle, updated_at)
          VALUES ($1,$2,$3,$4,now())
          ON CONFLICT (league_id, team_id)
          DO UPDATE SET member_id=COALESCE(EXCLUDED.member_id, ff_team_owner.member_id),
                        owner_handle=COALESCE(EXCLUDED.owner_handle, ff_team_owner.owner_handle),
                        updated_at=now()
        `, [leagueId, teamId, ownerId, ownerHdl]);

        // week=1 == season totals (what PP needs)
        await pool.query(`
          INSERT INTO ff_team_weekly_points (season, league_id, team_id, week, points, wins, losses, ties, updated_at)
          VALUES ($1,$2,$3, 1, $4,$5,$6,$7, now())
          ON CONFLICT (season, league_id, team_id, week)
          DO UPDATE SET points=EXCLUDED.points, wins=EXCLUDED.wins, losses=EXCLUDED.losses, ties=EXCLUDED.ties, updated_at=now()
        `, [season, leagueId, teamId, pf, wins, losses, ties]);
      }

      // 5) optional denormalized cache for fast FE reads
      await pool.query(`
        DELETE FROM ff_team_points_cache WHERE season=$1 AND league_id=$2;
        INSERT INTO ff_team_points_cache (season, league_id, team_id, season_points, updated_at)
        SELECT season, league_id, team_id, points, now()
        FROM ff_team_weekly_points
        WHERE season=$1 AND league_id=$2 AND week=1;
      `, [season, leagueId]);
    }
  }

    res.json({ ok:true, season, leaguesCount: leagueIds.length });
  } catch (e) {
    console.error('[ingest/fan]', e);
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

module.exports = router;
