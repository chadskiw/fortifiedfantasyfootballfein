// routes/widget.js
// Public-facing Team Edge widget API. Combines cached FEIN data with league-wide
// aggregates so the embeddable widget can brag with real numbers without
// needing live ESPN credentials from the viewer.

const express = require('express');
const router = express.Router();

const cors = require('cors');              // 👈 add this

const pool = require('../src/db/pool');

const ALLOWED_ORIGINS = [
  'https://widget-test-9d8.pages.dev',
  'https://fortifiedfantasy.com',
  // add other sites that will embed this widget if you want
];

// Apply CORS to all routes in this router
router.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server / curl (no origin) and configured origins
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'OPTIONS'],
  })
);

const CURRENT_SEASON = Number(process.env.FF_CURRENT_SEASON) || new Date().getUTCFullYear();

const clamp = (val, lo, hi) => Math.min(hi, Math.max(lo, val));
const round = (value, digits = 1) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
};
const asInt = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
};

function normalizeRecord(record) {
  if (!record) return null;
  const overall = record.overall || record;
  const wins = asInt(overall?.wins) || 0;
  const losses = asInt(overall?.losses) || 0;
  const ties = asInt(overall?.ties) || 0;
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function momentumLabel(score) {
  if (score >= 0.75) return 'Blazing';
  if (score >= 0.6) return 'Heating Up';
  if (score >= 0.45) return 'Steady';
  if (score >= 0.3) return 'Grinding';
  return 'Reset Mode';
}

router.get('/team-edge', async (req, res) => {
  const leagueIdRaw =
    req.query.leagueId ||
    req.query.leagueID ||
    req.query.league_id ||
    req.query.league ||
    '';
  const leagueId = String(leagueIdRaw || '').trim();
  const teamId = asInt(req.query.teamId ?? req.query.team_id ?? req.query.team);
  const season = asInt(req.query.season) || CURRENT_SEASON;
  const scoring = String(req.query.scoring || 'PPR').toUpperCase();

  if (!leagueId || !teamId) {
    return res.status(400).json({ error: 'leagueId and teamId required' });
  }

  const client = await pool.connect();
  try {
    // Latest cache row (week + season totals)
    const { rows: cacheRows } = await client.query(
      `
        SELECT season, league_id, team_id, team_name, scoring, week,
               week_pts, season_pts, updated_at
          FROM ff_team_points_cache
         WHERE season = $1
           AND league_id::text = $2::text
           AND team_id::int = $3::int
           AND scoring = $4
         ORDER BY week DESC
         LIMIT 1
      `,
      [season, leagueId, teamId, scoring]
    );
    const cacheRow = cacheRows[0];
    if (!cacheRow) {
      return res.status(404).json({ error: 'team_not_found' });
    }

    // Weekly data (exclude week 1 which is the season alias)
    const { rows: weeklyRows } = await client.query(
      `
        SELECT week, points
          FROM ff_team_weekly_points
         WHERE season = $1
           AND league_id::text = $2::text
           AND team_id::int = $3::int
           AND scoring = $4
           AND week > 1
         ORDER BY week ASC
      `,
      [season, leagueId, teamId, scoring]
    );
    const playedWeeks = weeklyRows.length;
    const totalWeeklyPoints = weeklyRows.reduce((sum, row) => sum + Number(row.points || 0), 0);
    const teamWeeklyAvg =
      playedWeeks > 0
        ? totalWeeklyPoints / playedWeeks
        : Number(cacheRow.season_pts || 0);

    const [{ rows: leagueWeekAggRows }, { rows: leagueSeasonAggRows }] = await Promise.all([
      client.query(
        `
          SELECT AVG(points)::numeric AS avg_pts
            FROM ff_team_weekly_points
           WHERE season = $1
             AND league_id::text = $2::text
             AND scoring = $3
             AND week > 1
        `,
        [season, leagueId, scoring]
      ),
      client.query(
        `
          SELECT AVG(points)::numeric AS avg_pts
            FROM ff_team_weekly_points
           WHERE season = $1
             AND league_id::text = $2::text
             AND scoring = $3
             AND week = 1
        `,
        [season, leagueId, scoring]
      ),
    ]);

    const leagueAvgPerGame = Number(leagueWeekAggRows[0]?.avg_pts || 0);
    const seasonLeagueAvg = Number(leagueSeasonAggRows[0]?.avg_pts || 0) || Number(cacheRow.season_pts || 0);

    const deltaPerGame = round(teamWeeklyAvg - leagueAvgPerGame);

    // Week-level comparison
    const currentWeek = Number(cacheRow.week) || null;
    let weekLeagueAvg = leagueAvgPerGame;
    if (currentWeek) {
      const { rows } = await client.query(
        `
          SELECT AVG(points)::numeric AS avg_pts
            FROM ff_team_weekly_points
           WHERE season = $1
             AND league_id::text = $2::text
             AND scoring = $3
             AND week = $4
        `,
        [season, leagueId, scoring, currentWeek]
      );
      weekLeagueAvg = Number(rows[0]?.avg_pts || weekLeagueAvg || 0);
    }

    const ffProj = round(cacheRow.week_pts || 0, 1);
    const espnProj = round(weekLeagueAvg || ffProj, 1);
    const weekDelta = round(ffProj - espnProj, 1);

    // Rank + league size from cache (week=1 rows)
    const { rows: rankRows } = await client.query(
      `
        WITH season_rows AS (
          SELECT
            team_id,
            season_pts,
            RANK() OVER (ORDER BY season_pts DESC NULLS LAST) AS rk
          FROM ff_team_points_cache
          WHERE season = $1
            AND league_id::text = $2::text
            AND scoring = $3
            AND week = 1
        )
        SELECT rk FROM season_rows WHERE team_id::int = $4::int
      `,
      [season, leagueId, scoring, teamId]
    );
    const rank = rankRows[0]?.rk ? Number(rankRows[0].rk) : null;

    const { rows: sizeRows } = await client.query(
      `
        SELECT COUNT(DISTINCT team_id)::int AS size
          FROM ff_team_points_cache
         WHERE season = $1
           AND league_id::text = $2::text
           AND scoring = $3
           AND week = 1
      `,
      [season, leagueId, scoring]
    );
    const leagueSize = sizeRows[0]?.size || null;

    // Record from ff_team (ingested via espn-fan)
    const { rows: teamRows } = await client.query(
      `
        SELECT name, record
          FROM ff_team
         WHERE platform = 'espn'
           AND season = $1
           AND league_id::text = $2::text
           AND team_id::int = $3::int
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1
      `,
      [season, leagueId, teamId]
    );
    const recordStr = teamRows[0]?.record ? normalizeRecord(teamRows[0].record) : null;

    const seasonPts = Number(cacheRow.season_pts || 0);
    const playoffsEspn = round(seasonLeagueAvg || seasonPts, 1);
    const playoffsDelta = round(seasonPts - playoffsEspn, 1);

    const leagueAvgSafe = leagueAvgPerGame || (seasonPts && playedWeeks ? seasonPts / Math.max(playedWeeks, 1) : espnProj);
    const recentSample = weeklyRows.slice(-3);
    const recentAvg =
      recentSample.length > 0
        ? recentSample.reduce((sum, row) => sum + Number(row.points || 0), 0) / recentSample.length
        : teamWeeklyAvg;
    const momentumScore = recentAvg - leagueAvgSafe;
    const momentumValue = clamp(0.5 + momentumScore / 30, 0, 1);

    const confidenceWeek = clamp(0.55 + weekDelta / Math.max(Math.abs(espnProj) + 25, 30), 0.08, 0.95);
    const confidencePlayoffs = clamp(0.5 + playoffsDelta / Math.max(Math.abs(playoffsEspn) + 120, 140), 0.1, 0.92);

    const oddsRaw =
      rank && leagueSize
        ? Math.round(clamp(1 - (rank - 1) / leagueSize, 0.05, 0.98) * 100)
        : Math.round(clamp(0.55 + momentumValue / 3, 0.3, 0.95) * 100);

    const insights = [
      `Averaging ${round(teamWeeklyAvg, 1)} pts (${deltaPerGame >= 0 ? '+' : ''}${round(deltaPerGame, 1)} vs league).`,
      `Season total ${round(seasonPts, 1)} pts (${playoffsDelta >= 0 ? '+' : ''}${playoffsDelta} vs baseline).`,
      rank && leagueSize ? `Point rank #${rank} of ${leagueSize}.` : `Tracking ${round(momentumValue * 100)}% win pace.`,
      `Last card: ${ffProj} vs league ${espnProj}.`,
    ];

    const hypeLines = [
      `Model projects ${weekDelta >= 0 ? '+' : ''}${weekDelta} this matchup.`,
      `Recent ${recentSample.length || playedWeeks || 1} weeks: ${round(recentAvg, 1)} pts per tilt.`,
      `Season pace beating league by ${deltaPerGame >= 0 ? '+' : ''}${round(deltaPerGame, 1)} a week.`,
      `Playoff odds clock in near ${oddsRaw}% with current surge.`,
    ];

    const response = {
      teamName: teamRows[0]?.name || cacheRow.team_name,
      record: recordStr,
      rank: rank || null,
      size: leagueSize,
      thisWeek: {
        espnProj,
        ffProj,
        delta: weekDelta,
        confidence: Number(confidenceWeek.toFixed(2)),
        callout: 'Edge this week',
      },
      playoffs: {
        espnProj: playoffsEspn,
        ffProj: round(seasonPts, 1),
        delta: playoffsDelta,
        confidence: Number(confidencePlayoffs.toFixed(2)),
        odds: oddsRaw,
        callout: 'Playoff surge',
      },
      season: {
        deltaPerGame: round(deltaPerGame, 1),
      },
      momentum: {
        value: Number(momentumValue.toFixed(2)),
        label: momentumLabel(momentumValue),
      },
      insights,
      hypeLines,
      tagline:
        deltaPerGame >= 0
          ? `Fortified model shows +${round(deltaPerGame, 1)} pts per matchup vs league baseline.`
          : `Closing a ${Math.abs(round(deltaPerGame, 1))} pt gap per game keeps you in the hunt.`,
      deeplink: `https://fortifiedfantasy.com/fein/?season=${season}&leagueId=${encodeURIComponent(
        leagueId
      )}&teamId=${encodeURIComponent(teamId)}`,
    };

    res.set('Cache-Control', 'no-store');
    return res.json(response);
  } catch (error) {
    console.error('[widget] team-edge error', error);
    return res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

module.exports = router;
