// routes/challenges.js
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const cookie = require('cookie');

const router = express.Router();

// --- DB ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

// --- helpers ---
const rid = (p = 'ch') => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
const nowWeek = () => Number(process.env.FF_CURRENT_WEEK || 7);

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

// side normalizer: home/1 -> 1, away/2 -> 2 (default home)
function normSide(s) {
  const v = String(s ?? 'home').toLowerCase();
  if (v === '2' || v === 'away') return 2;
  return 1;
}

// pull cookies (supports cookie-parser or manual)
function getCookies(req) {
  return req.cookies ?? parseCookies(req.headers.cookie || '');
}

// resolve/stitch member using ff_session + ff_member cookies
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

    // ensure member exists
    await pool.query(
      `INSERT INTO ff_member (member_id, created_at, updated_at)
       VALUES ($1, now(), now())
       ON CONFLICT (member_id) DO NOTHING`,
      [mid]
    );

    // link/create session
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

// accept nested team OR root keys OR querystring
function readTeamFrom(reqBody, reqQuery) {
  const b = reqBody || {};
  if (b.team && (b.team.leagueId || b.team.teamId)) return b.team;

  return {
    platform: b.platform ?? reqQuery.platform ?? 'espn',
    leagueId: b.leagueId ?? reqQuery.leagueId ?? null,
    teamId: b.teamId ?? reqQuery.teamId ?? null,
    teamName: b.teamName ?? reqQuery.teamName ?? null,
  };
}

async function readChallengeAggregate(id) {
  const { rows } = await pool.query(
    `SELECT c.*,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'side', s.side,
                  'platform', s.platform, 'season', s.season,
                  'league_id', s.league_id, 'team_id', s.team_id,
                  'team_name', s.team_name, 'owner_member_id', s.owner_member_id,
                  'locked_at', s.locked_at, 'points_final', s.points_final
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

// ---------------------------------------------------------------------------
// POST /api/challenges/:id/claim
// body accepts either:
//   { side, value, season, week, team:{platform,leagueId,teamId,teamName} }
// or root form:
//   { side, value, season, week, platform, leagueId, teamId, teamName }
// (also honors querystring fallbacks)
// ---------------------------------------------------------------------------
router.post('/api/challenges/:id/claim', async (req, res) => {
  try {
    const auth = await resolveMemberId(req);
    if (auth.error) return res.status(401).json({ ok: false, error: auth.error });
    const memberId = auth.memberId;

    const q = req.query || {};
    const b = req.body || {};

    const season = b.season != null ? Number(b.season) : (q.season != null ? Number(q.season) : null);
    const week = b.week != null ? Number(b.week) : (q.week != null ? Number(q.week) : null);
    const value = Number(b.value ?? q.value ?? 0);
    const side = normSide(b.side ?? q.side);
    const team = readTeamFrom(b, q);

    const missing = [];
    if (!team.leagueId) missing.push('team.leagueId');
    if (!team.teamId) missing.push('team.teamId');
    if (missing.length) return res.status(400).json({ ok: false, error: 'bad_args', missing });

    const challengeId = req.params.id;

    // lazily create/refresh challenge
    await pool.query(
      `INSERT INTO ff_challenge (id, season, week, status, stake_points, created_at, updated_at)
       VALUES ($1, $2, $3, 'open', $4, now(), now())
       ON CONFLICT (id) DO UPDATE
         SET season = COALESCE(EXCLUDED.season, ff_challenge.season),
             week   = COALESCE(EXCLUDED.week,   ff_challenge.week),
             stake_points = COALESCE(EXCLUDED.stake_points, ff_challenge.stake_points),
             updated_at = now()`,
      [challengeId, season, week, value]
    );

    // prevent stealing a claimed side
    const { rows: claimRows } = await pool.query(
      `SELECT owner_member_id FROM ff_challenge_side WHERE challenge_id=$1 AND side=$2`,
      [challengeId, side]
    );
    if (claimRows[0]?.owner_member_id && String(claimRows[0].owner_member_id) !== String(memberId)) {
      return res.status(409).json({ ok: false, error: 'side_already_claimed' });
    }

    // NOTE: requires UNIQUE (challenge_id, side)
    await pool.query(
      `INSERT INTO ff_challenge_side
         (challenge_id, side, platform, season, league_id, team_id, team_name, owner_member_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (challenge_id, side) DO UPDATE
         SET platform       = EXCLUDED.platform,
             season         = COALESCE(EXCLUDED.season, ff_challenge_side.season),
             league_id      = EXCLUDED.league_id,
             team_id        = EXCLUDED.team_id,
             team_name      = COALESCE(EXCLUDED.team_name, ff_challenge_side.team_name),
             owner_member_id= EXCLUDED.owner_member_id`,
      [
        challengeId,
        side,
        team.platform || 'espn',
        season,
        String(team.leagueId),
        String(team.teamId),
        team.teamName || null,
        memberId,
      ]
    );

    const challenge = await readChallengeAggregate(challengeId);
    return res.json({ ok: true, challenge });
  } catch (e) {
    console.error('claim failed', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/challenges/claim-lock
// Same as claim, but also locks a lineup (sets locked_at) and bumps status.
// body: { id?, clientId?, season, week, value, side, team{...}, lineup{starters,bench} }
// If id absent + clientId absent, it creates a new challenge id.
// ---------------------------------------------------------------------------
router.post('/api/challenges/claim-lock', async (req, res) => {
  const client = await pool.connect();
  try {
    const auth = await resolveMemberId(req);
    if (auth.error) return res.status(401).json({ ok: false, error: auth.error });
    const memberId = auth.memberId;

    const b = req.body || {};
    const q = req.query || {};

    const id = b.id || null;
    const clientId = b.clientId || null;
    const season = Number(b.season ?? q.season);
    const week = Number(b.week ?? q.week);
    const value = Number(b.value ?? q.value ?? 0);
    const side = normSide(b.side ?? q.side);
    const team = readTeamFrom(b, q);
    const lineup = b.lineup || {};

    const missing = [];
    if (!season) missing.push('season');
    if (!week) missing.push('week');
    if (!team.leagueId) missing.push('team.leagueId');
    if (!team.teamId) missing.push('team.teamId');
    if (missing.length) return res.status(400).json({ ok: false, error: 'bad_args', missing });

    if (week < nowWeek()) return res.status(400).json({ ok: false, error: 'past_week' });

    await client.query('BEGIN');

    // find existing by id or clientId
    let challengeId = id || null;
    if (!challengeId && clientId) {
      const { rows: ex } = await client.query(
        `SELECT id FROM ff_challenge WHERE client_id = $1 LIMIT 1`,
        [clientId]
      );
      challengeId = ex[0]?.id || null;
    }
    if (!challengeId) challengeId = rid('ch');

    // upsert challenge
    await client.query(
      `INSERT INTO ff_challenge (id, season, week, scoring_profile_id, status, stake_points, client_id, created_at, updated_at)
       VALUES ($1,$2,$3,NULL,'open',$4,$5, now(), now())
       ON CONFLICT (id) DO UPDATE
         SET season=$2, week=$3, stake_points=$4, client_id=COALESCE(ff_challenge.client_id, $5), updated_at=now()`,
      [challengeId, season, week, value, clientId]
    );

    // existing side ownership?
    const { rows: claimRows } = await client.query(
      `SELECT owner_member_id FROM ff_challenge_side WHERE challenge_id=$1 AND side=$2`,
      [challengeId, side]
    );
    if (claimRows[0]?.owner_member_id && String(claimRows[0].owner_member_id) !== String(memberId)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'side_already_claimed' });
    }

    // upsert side & lock
    await client.query(
      `INSERT INTO ff_challenge_side
         (challenge_id, side, platform, season, league_id, team_id, team_name,
          owner_member_id, lineup_json, bench_json, locked_at, points_final)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), NULL)
       ON CONFLICT (challenge_id, side) DO UPDATE SET
         platform=$3, season=$4, league_id=$5, team_id=$6, team_name=$7,
         owner_member_id=$8, lineup_json=$9, bench_json=$10, locked_at=now()`,
      [
        challengeId,
        side,
        team.platform || 'espn',
        season,
        String(team.leagueId),
        String(team.teamId),
        team.teamName || null,
        memberId,
        lineup?.starters || null,
        lineup?.bench || null,
      ]
    );

    // bump status when both locked
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
      [rid('che'), challengeId, memberId, { side, value }]
    );

    await client.query('COMMIT');

    const challenge = await readChallengeAggregate(challengeId);
    return res.json({ ok: true, challenge });
  } catch (e) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error('claim-lock failed', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  } finally {
    // eslint-disable-next-line no-unsafe-finally
    try { (await pool.connect()).release(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// POST /api/challenges        (create explicitly)
// body: { season, week, scoring_profile_id?, home{...}, away{...} }
// ---------------------------------------------------------------------------
);

router.post('/api/challenges', async (req, res) => {
  const { season, week, scoring_profile_id = null, home = {}, away = {} } = req.body || {};
  if (!season || !week || !home.leagueId || !home.teamId || !away.leagueId || !away.teamId) {
    return res.status(400).json({ ok: false, error: 'invalid_payload' });
  }
  const id = rid('ch');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO ff_challenge (id, season, week, scoring_profile_id, status, stake_points, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'open',0, now(), now())`,
      [id, Number(season), Number(week), scoring_profile_id]
    );

    // side 1 (home)
    await client.query(
      `INSERT INTO ff_challenge_side
         (challenge_id, side, platform, season, league_id, team_id, team_name, owner_member_id)
       VALUES ($1,1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        home.platform || 'espn',
        Number(season),
        String(home.leagueId),
        String(home.teamId),
        home.teamName || null,
        null,
      ]
    );

    // side 2 (away)
    await client.query(
      `INSERT INTO ff_challenge_side
         (challenge_id, side, platform, season, league_id, team_id, team_name, owner_member_id)
       VALUES ($1,2,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        away.platform || 'espn',
        Number(season),
        String(away.leagueId),
        String(away.teamId),
        away.teamName || null,
        null,
      ]
    );

    await client.query(
      `INSERT INTO ff_challenge_event (id, challenge_id, actor_member_id, type, data)
       VALUES ($1,$2,$3,'create',$4)`,
      [rid('che'), id, null, req.body]
    );

    await client.query('COMMIT');

    const challenge = await readChallengeAggregate(id);
    res.status(201).json({ ok: true, challenge });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('challenge create failed', e);
    res.status(500).json({ ok: false, error: 'challenge_create_failed' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /api/challenges?season=&leagueId=&teamId=
// ---------------------------------------------------------------------------
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
               'team_name', s.team_name, 'locked_at', s.locked_at,
               'points_final', s.points_final, 'owner_member_id', s.owner_member_id
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

    res.json({ ok: true, challenges: rows });
  } catch (e) {
    console.error('challenge list failed', e);
    res.status(500).json({ ok: false, error: 'challenge_list_failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/challenges/:id
// ---------------------------------------------------------------------------
router.get('/api/challenges/:id', async (req, res) => {
  try {
    const challenge = await readChallengeAggregate(req.params.id);
    res.json({ ok: true, challenge });
  } catch (e) {
    console.error('challenge get failed', e);
    res.status(500).json({ ok: false, error: 'challenge_get_failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/challenges/:id/lock
// body: { side: 1|2|'home'|'away', lineup:{starters,bench}, teamName? }
// ---------------------------------------------------------------------------
router.post('/api/challenges/:id/lock', async (req, res) => {
  try {
    const side = normSide(req.body?.side);
    if (![1, 2].includes(side)) {
      return res.status(400).json({ ok: false, error: 'invalid_side' });
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

    if (!rowCount) return res.status(404).json({ ok: false, error: 'challenge_side_not_found' });

    // bump challenge to pending if both locked
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
    res.json({ ok: true, challenge });
  } catch (e) {
    console.error('challenge lock failed', e);
    res.status(500).json({ ok: false, error: 'challenge_lock_failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/challenges/:id/score
// sums lineup_json.starters[].pts (or .points) → points_final; status → closed
// ---------------------------------------------------------------------------
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
      return res.status(400).json({ ok: false, error: 'invalid_challenge' });
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
      [rid('che'), req.params.id, null, { hp, ap }]
    );

    await client.query('COMMIT');

    const challenge = await readChallengeAggregate(req.params.id);
    res.json({ ok: true, challenge });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('challenge score failed', e);
    res.status(500).json({ ok: false, error: 'challenge_score_failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
