// TRUE_LOCATION: routes/espn/pole-position.js
// IN_USE: GET /api/platforms/espn/pole-position?season=&leagueId=&scope=&week=&scoring=
//
// Scope:  week   -> uses week_pts
//         season -> uses season_pts
//
// Scoring: STD | HALF | PPR

const express = require('express');
const router = express.Router();

// Use the same pool module your server uses
const pool = require('../../src/db/pool');

function send(res, body, status = 200) {
  res
    .status(status)
    .set({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    .send(JSON.stringify(body));
}

// CORS preflight (global CORS already applied in server.js, but this is harmless)
router.options('/pole-position', (_req, res) => res.sendStatus(204));

router.get('/pole-position', async (req, res) => {
  try {
    const season   = Number(req.query.season || req.headers['x-ff-season']);
    const leagueId = String(req.query.leagueId || req.headers['x-ff-leagueid'] || '');
    const scopeRaw = String(req.query.scope || 'week').toLowerCase();
    const scoring  = String(req.query.scoring || 'PPR').toUpperCase();
    const weekRaw  = req.query.week ? Number(req.query.week) : null;

    if (!season || !leagueId) {
      return send(res, { ok:false, error:'season and leagueId required' }, 400);
    }
    const scope = (scopeRaw === 'season') ? 'season' : 'week';
    if (!['STD','HALF','PPR'].includes(scoring)) {
      return send(res, { ok:false, error:'scoring must be STD|HALF|PPR' }, 400);
    }

    const client = await pool.connect();
    try {
      // Determine the target week (explicit or latest present for league/scoring)
      const wq = await client.query(
        `SELECT COALESCE($1::int, MAX(week)) AS target_week
           FROM ff_team_points_cache
          WHERE season = $2 AND league_id = $3 AND scoring = $4`,
        [weekRaw, season, leagueId, scoring]
      );
      const targetWeek = wq.rows?.[0]?.target_week || weekRaw || 1;

      // Choose points column safely (validated scope above)
      const pointsCol = scope === 'season' ? 'season_pts' : 'week_pts';

      const q = await client.query(
        `
        WITH base AS (
          SELECT
            c.team_id,
            MAX(c.team_name) AS team_name,
            MAX(c.week)      AS week,
            MAX(c.scoring)   AS scoring,
            -- Optional decorations from ff_sport_ffl (safe COALESCEs)
            COALESCE(MAX(f.owner_handle), '') AS owner_handle,
            COALESCE(MAX(f.team_hex), '#888') AS team_hex,
            COALESCE(MAX(f.avatar_url), '')   AS avatar_url,
            MAX(c.${pointsCol})               AS points
          FROM ff_team_points_cache c
          LEFT JOIN ff_sport_ffl f
            ON f.season=c.season AND f.league_id=c.league_id AND f.team_id=c.team_id
          WHERE c.season=$1 AND c.league_id=$2 AND c.scoring=$3 AND c.week=$4
          GROUP BY c.team_id
        )
        SELECT * FROM base
        ORDER BY points DESC NULLS LAST, team_name ASC
        `,
        [season, leagueId, scoring, targetWeek]
      );

      const rows = (q.rows || []).map((r, i) => ({
        rank: i + 1,
        teamId: r.team_id,
        teamName: r.team_name,
        points: Number(r.points || 0),
        week: r.week,
        scoring: r.scoring,
        owner_handle: r.owner_handle || null,
        team_hex: r.team_hex || null,
        avatar_url: r.avatar_url || null,
      }));

      return send(res, {
        ok: true,
        meta: { season, leagueId, scope, week: Number(targetWeek), scoring },
        rows,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[espn/pole-position] error:', err);
    return send(res, { ok:false, error:String(err?.message || err) }, 500);
  }
});

module.exports = router;
