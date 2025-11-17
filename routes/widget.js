// routes/widget.js
// Public-facing Team Edge widget API. Combines cached FEIN data with league-wide
// aggregates so the embeddable widget can brag with real numbers without
// needing live ESPN credentials from the viewer.

const express = require('express');
const router = express.Router();

const cors = require('cors');

const pool = require('../src/db/pool');
const {
  pullFreeAgentsDirect,
  normEspnPlayer,
  vWeek: valueFromPlayer,
} = require('./espn/free-agents-with-team');

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
const CURRENT_WEEK = Number(process.env.FF_CURRENT_WEEK || process.env.CURRENT_WEEK) || 1;

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

async function fetchFreeAgentSuggestion({ season, leagueId, teamId, week }, req) {
  try {
    const { rows } = await pullFreeAgentsDirect(
      {
        season,
        leagueId,
        week,
        pos: 'ALL',
        teamId: Number(teamId),
      },
      req
    );

    if (!Array.isArray(rows) || !rows.length) return null;

    const players = rows
      .map((p) => normEspnPlayer(p, week))
      .filter((p) => p?.name)
      .map((p) => ({
        ...p,
        value: valueFromPlayer(p),
      }))
      .sort((a, b) => (b.value || 0) - (a.value || 0));

    const target =
      players.find((p) => ['RB', 'WR', 'TE'].includes(p.pos)) ||
      players.find((p) => ['QB', 'DST', 'K'].includes(p.pos)) ||
      players[0];
    if (!target) return null;

    const projection = target.proj != null ? round(target.proj, 1) : target.value ? round(target.value, 1) : null;
    return {
      name: target.name,
      pos: target.pos,
      team: target.team,
      proj: projection,
      headshot: target.headshot,
      headline: projection
        ? `Add ${target.name} (${target.pos}) for +${projection.toFixed(1)} pts`
        : `Add ${target.name} (${target.pos})`,
      blurb: projection
        ? `${target.name} is projected for ${projection.toFixed(1)} pts in week ${week}.`
        : `${target.name} headlines available ${target.pos}s this week.`,
    };
  } catch (err) {
    console.warn('[widget] free-agent suggestion failed', err?.message || err);
    return null;
  }
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
  const teamIdText = teamId != null ? String(teamId) : null;
  const season = asInt(req.query.season) || CURRENT_SEASON;
  let scoring = String(req.query.scoring || 'PPR').toUpperCase();

  if (!leagueId || teamIdText == null) {
    return res.status(400).json({ error: 'leagueId and teamId required' });
  }

  const client = await pool.connect();
  try {
    let { rows: historyRows } = await client.query(
      `
        SELECT season, league_id, team_id, team_name, scoring, week,
               week_pts, season_pts, updated_at
          FROM ff_team_points_cache
         WHERE season = $1
           AND league_id::text = $2::text
           AND team_id::text = $3::text
           AND scoring = $4
         ORDER BY week DESC
      `,
      [season, leagueId, teamIdText, scoring]
    );

    if (!historyRows.length) {
      const fallback = await client.query(
        `
          SELECT season, league_id, team_id, team_name, scoring, week,
                 week_pts, season_pts, updated_at
            FROM ff_team_points_cache
           WHERE season = $1
             AND league_id::text = $2::text
             AND team_id::text = $3::text
           ORDER BY week DESC
        `,
        [season, leagueId, teamIdText]
      );
      if (!fallback.rows.length) {
        return res.status(404).json({ error: 'team_not_found' });
      }
      historyRows = fallback.rows;
      scoring = fallback.rows[0].scoring;
    }

    const latestRow = historyRows[0];
    const currentWeek = Number(latestRow.week) || CURRENT_WEEK;

    const weekRows = historyRows.filter((row) => Number(row.week) > 0);
    const weekCount = weekRows.length || currentWeek || 1;
    const teamWeeklyAvg =
      weekRows.length > 0
        ? weekRows.reduce((sum, row) => sum + Number(row.week_pts || 0), 0) / weekRows.length
        : Number(latestRow.week_pts || 0);
    const recentSample = weekRows.slice(0, Math.min(3, weekRows.length));
    const recentAvg =
      recentSample.length > 0
        ? recentSample.reduce((sum, row) => sum + Number(row.week_pts || 0), 0) / recentSample.length
        : teamWeeklyAvg;

    const ffProj = round(latestRow.week_pts || 0, 1);

    const { rows: leagueWeekAggRows } = await client.query(
      `
        SELECT AVG(week_pts)::numeric AS avg_pts
          FROM ff_team_points_cache
         WHERE season = $1
           AND league_id::text = $2::text
           AND scoring = $3
           AND week = $4
      `,
      [season, leagueId, scoring, currentWeek]
    );

    const { rows: seasonAggRows } = await client.query(
      `
        WITH latest AS (
          SELECT DISTINCT ON (team_id)
            team_id,
            season_pts
          FROM ff_team_points_cache
          WHERE season = $1
            AND league_id::text = $2::text
            AND scoring = $3
          ORDER BY team_id, week DESC
        )
        SELECT AVG(season_pts)::numeric AS avg_pts, COUNT(*)::int AS team_count
          FROM latest
      `,
      [season, leagueId, scoring]
    );

    const leagueWeekAvg = Number(leagueWeekAggRows[0]?.avg_pts || 0);
    const leagueSeasonAvg = Number(seasonAggRows[0]?.avg_pts || 0);
    const leagueSize = seasonAggRows[0]?.team_count || null;

    const leagueAvgPerGame =
      leagueWeekAvg ||
      (leagueSeasonAvg && weekCount ? Number(leagueSeasonAvg) / Math.max(weekCount, 1) : Number(leagueSeasonAvg) || 0);
    const deltaPerGame = round(teamWeeklyAvg - leagueAvgPerGame);

    const espnProj = round(leagueWeekAvg || leagueAvgPerGame || ffProj, 1);
    const weekDelta = round(ffProj - espnProj, 1);

    const { rows: rankRows } = await client.query(
      `
        WITH latest AS (
          SELECT DISTINCT ON (team_id)
            team_id,
            season_pts
          FROM ff_team_points_cache
          WHERE season = $1
            AND league_id::text = $2::text
            AND scoring = $3
          ORDER BY team_id, week DESC
        ),
        ranked AS (
          SELECT
            team_id,
            season_pts,
            RANK() OVER (ORDER BY season_pts DESC NULLS LAST) AS rk
          FROM latest
        )
        SELECT rk FROM ranked WHERE team_id::text = $4::text
      `,
      [season, leagueId, scoring, teamIdText]
    );
    const rank = rankRows[0]?.rk ? Number(rankRows[0].rk) : null;

    const { rows: teamRows } = await client.query(
      `
        SELECT name, record
          FROM ff_team
         WHERE (platform = 'espn' OR platform = '018')
           AND season = $1
           AND league_id::text = $2::text
           AND team_id::text = $3::text
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1
      `,
      [season, leagueId, teamIdText]
    );
    const recordStr = teamRows[0]?.record ? normalizeRecord(teamRows[0].record) : null;

    const seasonPts = Number(latestRow.season_pts || 0);
    const playoffsEspn = round(leagueSeasonAvg || seasonPts, 1);
    const playoffsDelta = round(seasonPts - playoffsEspn, 1);

    const leagueAvgSafe =
      leagueAvgPerGame || (seasonPts && weekCount ? seasonPts / Math.max(weekCount, 1) : espnProj || 0);
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
      `Recent ${recentSample.length || weekRows.length || 1} weeks: ${round(recentAvg, 1)} pts per tilt.`,
      `Season pace beating league by ${deltaPerGame >= 0 ? '+' : ''}${round(deltaPerGame, 1)} a week.`,
      `Playoff odds clock in near ${oddsRaw}% with current surge.`,
    ];

    const faSuggestion = await fetchFreeAgentSuggestion(
      {
        season,
        leagueId,
        teamId: teamIdText,
        week: currentWeek < CURRENT_WEEK ? CURRENT_WEEK : currentWeek,
      },
      req
    );

    const response = {
      teamName: teamRows[0]?.name || latestRow.team_name,
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
      freeAgent: faSuggestion,
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
