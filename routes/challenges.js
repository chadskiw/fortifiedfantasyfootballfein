// routes/challenges.js
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const router = express.Router();

// #region db
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});
// #endregion db

// #region helpers-constants-and-ids
const FALLBACK_SEASON = Number(process.env.FF_CURRENT_SEASON || new Date().getFullYear());
const FALLBACK_WEEK   = Number(process.env.FF_CURRENT_WEEK   || 1);
const DEFAULT_PLATFORM = '018'; // ESPN code

const rid = (p = 'ch') => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
const newChallengeId = () => rid('ch');
const newSideId      = () => rid('chs');
const newEventId     = () => rid('che');
// #endregion helpers-constants-and-ids

// #region helpers-misc
const numOrNull = v =>
  (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

const normSide = (s) => {
  const v = String(s ?? 'home').toLowerCase();
  return (v === '2' || v === 'away') ? 2 : 1; // default home=1
};

function normalizePlatform(p) {
  if (!p) return DEFAULT_PLATFORM;
  const s = String(p).trim().toLowerCase();
  if (s === 'espn' || s === '018') return '018';
  // add other mappings here later (e.g., 'yahoo' -> '017')
  return p;
}

function parseCookies(header = '') {
  return Object.fromEntries(
    (header || '')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean)
      .map(kv => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i), decodeURIComponent(kv.slice(i + 1))];
      })
  );
}
const getCookies = (req) => req.cookies ?? parseCookies(req.headers.cookie || '');
// #endregion helpers-misc

// #region helpers-builder-extractors
function resolveSeasonWeek(body = {}, query = {}) {
  const b = body || {};
  const q = query || {};
  const fromBuilder = b.builder || {};
  const season = numOrNull(b.season ?? fromBuilder.season ?? q.season) ?? FALLBACK_SEASON;
  const week   = numOrNull(b.week   ?? fromBuilder.week   ?? q.week)   ?? FALLBACK_WEEK;
  return { season, week };
}

// Prefer builder.home/builder.away (by side), then builder.team, then body.team, then root/query.
function readTeamFrom(body = {}, query = {}, side = 1) {
  const b = body || {};
  const q = query || {};
  const fromBuilderTeam =
    (b.builder && b.builder.team) ? b.builder.team :
    (b.builder && side === 1 && b.builder.home) ? b.builder.home :
    (b.builder && side === 2 && b.builder.away) ? b.builder.away :
    null;

  const src = fromBuilderTeam || b.team || b || q;
  return {
    platform: src.platform ?? b.platform ?? q.platform ?? null,
    leagueId: src.leagueId ?? b.leagueId ?? q.leagueId ?? null,
    teamId:   src.teamId   ?? b.teamId   ?? q.teamId   ?? null,
    teamName: src.teamName ?? b.teamName ?? q.teamName ?? null,
  };
}
// #endregion helpers-builder-extractors

// #region helpers-auth
async function resolveMemberId(req) {
  const c = getCookies(req);
  const sid = c.ff_session_id;
  if (!sid) return { error: 'no_session' };

  const { rows: sessRows } = await pool.query(
    `SELECT member_id FROM ff_session WHERE session_id = $1`,
    [sid]
  );
  let memberId = sessRows[0]?.member_id ?? null;

  if (!memberId) {
    const mid = c.ff_member_id;
    if (!mid) return { error: 'no_member' };

    await pool.query(
      `INSERT INTO ff_member (member_id, created_at, updated_at)
       VALUES ($1, now(), now())
       ON CONFLICT (member_id) DO NOTHING`,
      [mid]
    );

    await pool.query(
      `INSERT INTO ff_session (session_id, member_id, created_at, last_seen_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (session_id) DO UPDATE
         SET member_id = EXCLUDED.member_id,
             last_seen_at = now()`,
      [sid, mid]
    );

    memberId = mid;
  }

  return { memberId };
}
// #endregion helpers-auth

// #region helpers-aggregate
async function readChallengeAggregate(id) {
  const { rows } = await pool.query(
    `SELECT c.*,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'side', s.side,
                  'platform', s.platform, 'season', s.season,
                  'league_id', s.league_id, 'team_id', s.team_id,
                  'team_name', s.team_name,
                  'claimed_by_member_id', s.owner_member_id,
                  'owner_member_id', s.owner_member_id,
                  'locked_at', s.locked_at,
                  'points_final', s.points_final,
                  -- NEW: expose roster snapshots + counts
                  'lineup', s.lineup_json,
                  'bench',  s.bench_json,
                  'lineup_count', COALESCE(jsonb_array_length(COALESCE(s.lineup_json->'starters','[]'::jsonb)),0),
                  'bench_count',  COALESCE(jsonb_array_length(COALESCE(s.bench_json,'[]'::jsonb)),0)
                )
                ORDER BY s.side
              ) FILTER (WHERE s.challenge_id IS NOT NULL),
              '[]'::jsonb
            ) AS sides
     FROM ff_challenge c
     LEFT JOIN ff_challenge_side s ON s.challenge_id = c.id
     WHERE c.id = $1
     GROUP BY c.id`,
    [id]
  );
  return rows[0] || null;
}

// #endregion helpers-aggregate

// ============================= ROUTES =============================

// #region route-POST-claim
// POST /api/challenges/:id/claim
// Anyone can claim any team for a side (no team ownership checks).
// Requires builder-provided team (leagueId & teamId). ?force=1 to take over.
router.post('/api/challenges/:id/claim', async (req, res) => {
  try {
    const auth = await resolveMemberId(req);
    if (auth.error) return res.status(401).json({ ok:false, error: auth.error });
    const memberId = auth.memberId;

    const q = req.query || {};
    const b = req.body || {};

    const side = normSide(b.side ?? q.side);
    const { season, week } = resolveSeasonWeek(b, q);
    const value = numOrNull(b.value ?? q.value) ?? 0;
    const force = String(q.force ?? b.force ?? '0') === '1';

    // Pull from builder first
    const team = readTeamFrom(b, q, side);
    const platform = normalizePlatform(team.platform);

    // Require league/team — no placeholders
    const missing = [];
    if (!team.leagueId) missing.push('leagueId (builder.*)');
    if (!team.teamId)   missing.push('teamId (builder.*)');
    if (missing.length) {
      return res.status(400).json({
        ok:false, error:'bad_args', missing,
        hint: 'Send via body.builder.home/away or body.builder.team (include platform/leagueId/teamId).'
      });
    }

    const challengeId = req.params.id;

    // Upsert challenge
    await pool.query(
      `INSERT INTO ff_challenge (id, season, week, status, stake_points, created_at, updated_at)
       VALUES ($1,$2,$3,'open',$4,now(),now())
       ON CONFLICT (id) DO UPDATE
         SET season=$2, week=$3,
             stake_points=COALESCE(EXCLUDED.stake_points, ff_challenge.stake_points),
             updated_at=now()`,
      [challengeId, season, week, value]
    );

    // Block overwrite unless ?force=1 (or same user)
    const { rows: sideRows } = await pool.query(
      `SELECT owner_member_id FROM ff_challenge_side WHERE challenge_id=$1 AND side=$2`,
      [challengeId, side]
    );
    const claimedBy = sideRows[0]?.owner_member_id || null;
    if (claimedBy && !force && String(claimedBy) !== String(memberId)) {
      return res.status(409).json({ ok:false, error:'side_already_claimed' });
    }

    // Insert or update side (requires non-null id/platform/league/team)
    await pool.query(
      `INSERT INTO ff_challenge_side
         (id, challenge_id, side, platform, season, league_id, team_id, team_name, owner_member_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (challenge_id, side) DO UPDATE
         SET platform=$4, season=$5, league_id=$6, team_id=$7, team_name=$8, owner_member_id=$9`,
      [
        newSideId(),
        challengeId,
        side,
        platform,
        season,
        String(team.leagueId),
        String(team.teamId),
        team.teamName || null,
        memberId,
      ]
    );

    const challenge = await readChallengeAggregate(challengeId);
    return res.json({ ok:true, challenge });
  } catch (e) {
    console.error('claim failed', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});
// #endregion route-POST-claim

// #region route-POST-claim-lock
// POST /api/challenges/claim-lock
// Claim + lock lineup in one shot. Requires builder team and season/week.
router.post('/api/challenges/claim-lock', async (req, res) => {
  const client = await pool.connect();
  try {
    const auth = await resolveMemberId(req);
    if (auth.error) {
      client.release();
      return res.status(401).json({ ok:false, error: auth.error });
    }
    const memberId = auth.memberId;

    const b = req.body || {};
    const q = req.query || {};

    const side = normSide(b.side ?? q.side);
    const { season, week } = resolveSeasonWeek(b, q);
    const value = numOrNull(b.value ?? q.value) ?? 0;
    const force = String(q.force ?? b.force ?? '0') === '1';
    const team = readTeamFrom(b, q, side);
    const platform = normalizePlatform(team.platform);
    const lineup = b.lineup || {};
    const id = b.id || null;
    const clientId = b.clientId || null;

    const missing = [];
    if (!season) missing.push('season');
    if (!week)   missing.push('week');
    if (!team.leagueId) missing.push('leagueId (builder.*)');
    if (!team.teamId)   missing.push('teamId (builder.*)');
    if (missing.length) {
      client.release();
      return res.status(400).json({ ok:false, error:'bad_args', missing });
    }

    await client.query('BEGIN');

    // Determine challenge id
    let challengeId = id || null;
    if (!challengeId && clientId) {
      const { rows: ex } = await client.query(
        `SELECT id FROM ff_challenge WHERE client_id=$1 LIMIT 1`,
        [clientId]
      );
      challengeId = ex[0]?.id || null;
    }
    if (!challengeId) challengeId = newChallengeId();

    // Upsert challenge
    await client.query(
      `INSERT INTO ff_challenge (id, season, week, scoring_profile_id, status, stake_points, client_id, created_at, updated_at)
       VALUES ($1,$2,$3,NULL,'open',$4,$5,now(),now())
       ON CONFLICT (id) DO UPDATE
         SET season=$2, week=$3, stake_points=$4,
             client_id=COALESCE(ff_challenge.client_id, $5),
             updated_at=now()`,
      [challengeId, season, week, value, clientId]
    );

    // Side claim policy
    const { rows: claimRows } = await client.query(
      `SELECT owner_member_id FROM ff_challenge_side WHERE challenge_id=$1 AND side=$2`,
      [challengeId, side]
    );
    const claimedBy = claimRows[0]?.owner_member_id || null;
    if (claimedBy && !force && String(claimedBy) !== String(memberId)) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ ok:false, error:'side_already_claimed' });
    }

    // Insert/update side + lock
    await client.query(
      `INSERT INTO ff_challenge_side
         (id, challenge_id, side, platform, season, league_id, team_id, team_name,
          owner_member_id, lineup_json, bench_json, locked_at, points_final)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),NULL)
       ON CONFLICT (challenge_id, side) DO UPDATE SET
         platform=$4, season=$5, league_id=$6, team_id=$7, team_name=$8,
         owner_member_id=$9, lineup_json=$10, bench_json=$11, locked_at=now()`,
      [
        newSideId(),
        challengeId,
        side,
        platform,
        season,
        String(team.leagueId),
        String(team.teamId),
        team.teamName || null,
        memberId,
        lineup?.starters || null,
        lineup?.bench || null,
      ]
    );

    // Bump status if both locked
    const { rows: sides } = await client.query(
      `SELECT side, locked_at FROM ff_challenge_side WHERE challenge_id=$1`,
      [challengeId]
    );
    const has1 = sides.some(r => r.side === 1 && r.locked_at);
    const has2 = sides.some(r => r.side === 2 && r.locked_at);
    const newStatus = has1 && has2 ? 'pending' : 'open';

    await client.query(
      `UPDATE ff_challenge SET status=$1, stake_points=$2, updated_at=now() WHERE id=$3`,
      [newStatus, value, challengeId]
    );

    await client.query(
      `INSERT INTO ff_challenge_event (id, challenge_id, actor_member_id, type, data)
       VALUES ($1,$2,$3,'claim_lock',$4)`,
      [newEventId(), challengeId, memberId, { side, value }]
    );

    await client.query('COMMIT');
    client.release();

    const challenge = await readChallengeAggregate(challengeId);
    return res.json({ ok:true, challenge });
  } catch (e) {
    try { await pool.query('ROLLBACK'); } catch {}
    console.error('claim-lock failed', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});
// #endregion route-POST-claim-lock

// #region route-POST-create
// POST /api/challenges  (explicit create; optional)
router.post('/api/challenges', async (req, res) => {
  const b = req.body || {};
  const { season, week } = resolveSeasonWeek(b, {});
  const scoring_profile_id = b.scoring_profile_id ?? null;
  const home = b.home || {};
  const away = b.away || {};

  const id = newChallengeId();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO ff_challenge (id, season, week, scoring_profile_id, status, stake_points, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'open',0,now(),now())`,
      [id, season, week, scoring_profile_id]
    );

    // Optional sides; include ids + normalized platform if present
    if (home.leagueId && home.teamId) {
      await client.query(
        `INSERT INTO ff_challenge_side
           (id, challenge_id, side, platform, season, league_id, team_id, team_name)
         VALUES ($1,$2,1,$3,$4,$5,$6,$7)`,
        [
          newSideId(),
          id,
          normalizePlatform(home.platform || DEFAULT_PLATFORM),
          season,
          String(home.leagueId),
          String(home.teamId),
          home.teamName || null,
        ]
      );
    }
    if (away.leagueId && away.teamId) {
      await client.query(
        `INSERT INTO ff_challenge_side
           (id, challenge_id, side, platform, season, league_id, team_id, team_name)
         VALUES ($1,$2,2,$3,$4,$5,$6,$7)`,
        [
          newSideId(),
          id,
          normalizePlatform(away.platform || DEFAULT_PLATFORM),
          season,
          String(away.leagueId),
          String(away.teamId),
          away.teamName || null,
        ]
      );
    }

    await client.query(
      `INSERT INTO ff_challenge_event (id, challenge_id, actor_member_id, type, data)
       VALUES ($1,$2,$3,'create',$4)`,
      [newEventId(), id, null, req.body]
    );

    await client.query('COMMIT');
    client.release();

    const challenge = await readChallengeAggregate(id);
    res.status(201).json({ ok:true, challenge });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('challenge create failed', e);
    res.status(500).json({ ok:false, error:'challenge_create_failed' });
  }
});
// #endregion route-POST-create

// #region route-GET-list
// GET /api/challenges?season=&leagueId=&teamId=
router.get('/api/challenges', async (req, res) => {
  try {
    const { season, leagueId, teamId } = req.query || {};
    const params = [];
    const where = [];

    if (season) {
      params.push(Number(season));
      where.push(`c.season = $${params.length}`);
    }
    if (leagueId && teamId) {
      params.push(String(leagueId), String(teamId));
      where.push(
        `EXISTS (
           SELECT 1 FROM ff_challenge_side s
           WHERE s.challenge_id = c.id
             AND s.league_id = $${params.length - 1}
             AND s.team_id   = $${params.length}
         )`
      );
    }

    const { rows } = await pool.query(
      `
      SELECT c.*,
             COALESCE(jsonb_agg(jsonb_build_object(
               'side', s.side,
               'platform', s.platform, 'season', s.season,
               'league_id', s.league_id, 'team_id', s.team_id,
               'team_name', s.team_name,
               'claimed_by_member_id', s.owner_member_id,
               'owner_member_id', s.owner_member_id,
               'locked_at', s.locked_at, 'points_final', s.points_final
             ) ORDER BY s.side) FILTER (WHERE s.challenge_id IS NOT NULL), '[]'::jsonb) AS sides
      FROM ff_challenge c
      LEFT JOIN ff_challenge_side s ON s.challenge_id = c.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 200
      `,
      params
    );

    res.json({ ok:true, challenges: rows });
  } catch (e) {
    console.error('challenge list failed', e);
    res.status(500).json({ ok:false, error:'challenge_list_failed' });
  }
});
// #endregion route-GET-list

// #region route-GET-one
// GET /api/challenges/:id
router.get('/api/challenges/:id', async (req, res) => {
  try {
    const challenge = await readChallengeAggregate(req.params.id);
    res.json({ ok:true, challenge });
  } catch (e) {
    console.error('challenge get failed', e);
    res.status(500).json({ ok:false, error:'challenge_get_failed' });
  }
});
// #endregion route-GET-one

// #region route-POST-lock
// POST /api/challenges/:id/lock
// body: { side: 1|2|'home'|'away', lineup:{starters,bench}, teamName? }
router.post('/api/challenges/:id/lock', async (req, res) => {
  try {
    const side = normSide(req.body?.side);
    if (![1, 2].includes(side)) {
      return res.status(400).json({ ok:false, error:'invalid_side' });
    }

    const lineup = req.body?.lineup || {};
    const bench = req.body?.bench || null;
    const teamName = req.body?.teamName || null;

    const { rowCount } = await pool.query(
      `UPDATE ff_challenge_side
       SET lineup_json = $1,
           bench_json  = $2,
           team_name   = COALESCE($3, team_name),
           locked_at   = now()
       WHERE challenge_id = $4 AND side = $5`,
      [lineup, bench, teamName, req.params.id, side]
    );

    if (!rowCount) return res.status(404).json({ ok:false, error:'challenge_side_not_found' });

    const { rows: sides } = await pool.query(
      `SELECT side, locked_at FROM ff_challenge_side WHERE challenge_id=$1`,
      [req.params.id]
    );
    const has1 = sides.some(r => r.side === 1 && r.locked_at);
    const has2 = sides.some(r => r.side === 2 && r.locked_at);
    if (has1 && has2) {
      await pool.query(`UPDATE ff_challenge SET status='pending', updated_at=now() WHERE id=$1`, [
        req.params.id,
      ]);
    }

    const challenge = await readChallengeAggregate(req.params.id);
    res.json({ ok:true, challenge });
  } catch (e) {
    console.error('challenge lock failed', e);
    res.status(500).json({ ok:false, error:'challenge_lock_failed' });
  }
});
// #endregion route-POST-lock

// #region route-POST-score
// POST /api/challenges/:id/score
// sums lineup_json.starters[].pts (or .points) → points_final; status → closed
router.post('/api/challenges/:id/score', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: sides } = await client.query(
      `SELECT id, side, lineup_json FROM ff_challenge_side WHERE challenge_id=$1 ORDER BY side`,
      [req.params.id]
    );
    if (sides.length !== 2) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ ok:false, error:'invalid_challenge' });
    }

    const sum = arr =>
      Array.isArray(arr) ? arr.reduce((n, p) => n + Number(p?.pts ?? p?.points ?? 0), 0) : 0;

    const home = sides.find(s => s.side === 1);
    const away = sides.find(s => s.side === 2);
    const hp = sum(home?.lineup_json?.starters);
    const ap = sum(away?.lineup_json?.starters);

    await client.query(`UPDATE ff_challenge_side SET points_final=$1 WHERE id=$2`, [hp, home.id]);
    await client.query(`UPDATE ff_challenge_side SET points_final=$1 WHERE id=$2`, [ap, away.id]);
    await client.query(`UPDATE ff_challenge SET status='closed', updated_at=now() WHERE id=$1`, [
      req.params.id,
    ]);

    await client.query(
      `INSERT INTO ff_challenge_event (id, challenge_id, actor_member_id, type, data)
       VALUES ($1,$2,$3,'score',$4)`,
      [newEventId(), req.params.id, null, { hp, ap }]
    );

    await client.query('COMMIT');
    client.release();

    const challenge = await readChallengeAggregate(req.params.id);
    res.json({ ok:true, challenge });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    console.error('challenge score failed', e);
    res.status(500).json({ ok:false, error:'challenge_score_failed' });
  }
});
// #endregion route-POST-score

module.exports = router;
