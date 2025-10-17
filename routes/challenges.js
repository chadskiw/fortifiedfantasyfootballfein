// routes/challenges.js
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const router = express.Router();

// ---------- DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ---------- helpers ----------
const FALLBACK_SEASON = Number(process.env.FF_CURRENT_SEASON || new Date().getFullYear());
const FALLBACK_WEEK   = Number(process.env.FF_CURRENT_WEEK   || 1);
// #region helpers-id-factories
// compact id generator with a prefix (ch_, chs_, che_)
const rid = (p = 'ch') =>
  `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;

const newChallengeId = () => rid('ch');
const newSideId      = () => rid('chs'); // <-- use this when inserting ff_challenge_side
const newEventId     = () => rid('che'); // events
// #endregion helpers-id-factories

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
const getCookies = req => req.cookies ?? parseCookies(req.headers.cookie || '');
// #region helpers-platform
const DEFAULT_PLATFORM = '018'; // ESPN

function normalizePlatform(p) {
  if (!p) return DEFAULT_PLATFORM;
  const s = String(p).trim().toLowerCase();
  if (s === 'espn' || s === '018') return '018';
  // add other mappings as you adopt more providers:
  // if (s === 'yahoo' || s === '017') return '017';
  return p; // pass-through for already-coded values
}
// #endregion helpers-platform

const normSide = s => {
  const v = String(s ?? 'home').toLowerCase();
  return (v === '2' || v === 'away') ? 2 : 1; // default home=1
};

const numOrNull = v => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

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

// accept nested team OR root keys OR querystring; totally optional
function readTeamFrom(body = {}, query = {}) {
  if (body.team) return body.team;
  return {
    platform: body.platform ?? query.platform ?? null,
    leagueId: body.leagueId ?? query.leagueId ?? null,
    teamId:   body.teamId   ?? query.teamId   ?? null,
    teamName: body.teamName ?? query.teamName ?? null,
  };
}

function resolveSeasonWeek(body = {}, query = {}) {
  // Prefer explicit values, then env fallbacks
  const season = numOrNull(body.season ?? query.season) ?? FALLBACK_SEASON;
  const week   = numOrNull(body.week   ?? query.week)   ?? FALLBACK_WEEK;
  return { season, week };
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
                  'team_name', s.team_name,
                  'claimed_by_member_id', s.owner_member_id,   -- alias for clarity
                  'owner_member_id', s.owner_member_id,        -- legacy
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

// ---------- ROUTES ----------

// POST /api/challenges/:id/claim
// Anyone can claim any team for a side. Team is optional. season/week default if not supplied.
// ?force=1 lets caller take over an already-claimed side.
router.post('/api/challenges/:id/claim', async (req, res) => {
  try {
    const auth = await resolveMemberId(req);
    if (auth.error) return res.status(401).json({ ok: false, error: auth.error });
    const memberId = auth.memberId;

    const q = req.query || {};
    const b = req.body || {};

    const { season, week } = resolveSeasonWeek(b, q);
    const value  = numOrNull(b.value ?? q.value) ?? 0;
    const side   = normSide(b.side ?? q.side);
    const force  = String(q.force ?? b.force ?? '0') === '1';
    const team   = readTeamFrom(b, q); // may be nulls

    const challengeId = req.params.id;

    // upsert challenge row (season/week are ALWAYS non-null now)
    await pool.query(
      `INSERT INTO ff_challenge (id, season, week, status, stake_points, created_at, updated_at)
       VALUES ($1, $2, $3, 'open', $4, now(), now())
       ON CONFLICT (id) DO UPDATE
         SET season = $2,
             week   = $3,
             stake_points = COALESCE(EXCLUDED.stake_points, ff_challenge.stake_points),
             updated_at = now()`,
      [challengeId, season, week, value]
    );

    // Existing side?
    const { rows: sideRows } = await pool.query(
      `SELECT owner_member_id FROM ff_challenge_side WHERE challenge_id=$1 AND side=$2`,
      [challengeId, side]
    );
    const claimedBy = sideRows[0]?.owner_member_id || null;

    if (claimedBy && !force && String(claimedBy) !== String(memberId)) {
      // Side is claimed by someone else; allow only if ?force=1
      return res.status(409).json({ ok: false, error: 'side_already_claimed' });
    }

    // Upsert side (NO team-ownership checks; any team allowed; team can be null for now)
// #region route-claim-upsert-side
// Upsert side (NO team-ownership checks; any team allowed; team can be null for now)
// NOTE: include `id` column so we never insert NULL into ff_challenge_side.id
// #region route-claim-upsert-side
// Upsert side (any team allowed; team fields may be null).
// Ensure non-null `id` and normalized, non-null `platform`.
const platform = normalizePlatform(team.platform);

await pool.query(
  `INSERT INTO ff_challenge_side
     (id, challenge_id, side, platform, season, league_id, team_id, team_name, owner_member_id)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
   ON CONFLICT (challenge_id, side) DO UPDATE
     SET platform        = COALESCE(EXCLUDED.platform, ff_challenge_side.platform),
         season          = COALESCE(EXCLUDED.season,   ff_challenge_side.season),
         league_id       = COALESCE(EXCLUDED.league_id,ff_challenge_side.league_id),
         team_id         = COALESCE(EXCLUDED.team_id,  ff_challenge_side.team_id),
         team_name       = COALESCE(EXCLUDED.team_name,ff_challenge_side.team_name),
         owner_member_id = EXCLUDED.owner_member_id`,
  [
    newSideId(),          // <- generate chs_* so id is never NULL
    challengeId,
    side,
    platform,             // <- ALWAYS non-null ("018" default)
    season,
    team.leagueId ? String(team.leagueId) : null,
    team.teamId   ? String(team.teamId)   : null,
    team.teamName || null,
    memberId,
  ]
);
// #endregion route-claim-upsert-side

// #endregion route-claim-upsert-side


    const challenge = await readChallengeAggregate(challengeId);
    return res.json({ ok: true, challenge });
  } catch (e) {
    console.error('claim failed', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// POST /api/challenges/claim-lock  (claim + lock lineup)
router.post('/api/challenges/claim-lock', async (req, res) => {
  const client = await pool.connect();
  try {
    const auth = await resolveMemberId(req);
    if (auth.error) {
      client.release();
      return res.status(401).json({ ok: false, error: auth.error });
    }
    const memberId = auth.memberId;

    const b = req.body || {};
    const q = req.query || {};

    const id = b.id || null;
    const clientId = b.clientId || null;
    const { season, week } = resolveSeasonWeek(b, q);
    const value = numOrNull(b.value ?? q.value) ?? 0;
    const side = normSide(b.side ?? q.side);
    const force  = String(q.force ?? b.force ?? '0') === '1';
    const team = readTeamFrom(b, q);
    const lineup = b.lineup || {};

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

    // upsert challenge (season/week always set)
    await client.query(
      `INSERT INTO ff_challenge (id, season, week, scoring_profile_id, status, stake_points, client_id, created_at, updated_at)
       VALUES ($1,$2,$3,NULL,'open',$4,$5, now(), now())
       ON CONFLICT (id) DO UPDATE
         SET season=$2, week=$3, stake_points=$4, client_id=COALESCE(ff_challenge.client_id, $5), updated_at=now()`,
      [challengeId, season, week, value, clientId]
    );

    // side claim policy
    const { rows: claimRows } = await client.query(
      `SELECT owner_member_id FROM ff_challenge_side WHERE challenge_id=$1 AND side=$2`,
      [challengeId, side]
    );
    const claimedBy = claimRows[0]?.owner_member_id || null;
    if (claimedBy && !force && String(claimedBy) !== String(memberId)) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ ok: false, error: 'side_already_claimed' });
    }

    // upsert side & lock (no team-ownership checks)
// #region route-claim-lock-upsert-side
// upsert side & lock (no team-ownership checks)
// include `id` so ff_challenge_side.id is never NULL on first insert
// #region route-claim-lock-upsert-side
// Upsert side & lock lineup. Ensure non-null id and platform.
const platform = normalizePlatform(team.platform);

await client.query(
  `INSERT INTO ff_challenge_side
     (id, challenge_id, side, platform, season, league_id, team_id, team_name,
      owner_member_id, lineup_json, bench_json, locked_at, points_final)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), NULL)
   ON CONFLICT (challenge_id, side) DO UPDATE SET
     platform=$4, season=$5, league_id=$6, team_id=$7, team_name=$8,
     owner_member_id=$9, lineup_json=$10, bench_json=$11, locked_at=now()`,
  [
    newSideId(),                 // <- chs_*
    challengeId,
    side,
    platform,                    // <- "018" default if missing
    season,
    team.leagueId ? String(team.leagueId) : null,
    team.teamId   ? String(team.teamId)   : null,
    team.teamName || null,
    memberId,
    lineup?.starters || null,
    lineup?.bench || null,
  ]
);
// #endregion route-claim-lock-upsert-side

// #endregion route-claim-lock-upsert-side


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
    client.release();

    const challenge = await readChallengeAggregate(challengeId);
    return res.json({ ok: true, challenge });
  } catch (e) {
    try { await pool.query('ROLLBACK'); } catch {}
    console.error('claim-lock failed', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// POST /api/challenges        (explicit create; optional)
router.post('/api/challenges', async (req, res) => {
  const b = req.body || {};
  const { season, week } = resolveSeasonWeek(b, {});
  const scoring_profile_id = b.scoring_profile_id ?? null;
  const home = b.home || {};
  const away = b.away || {};

  const id = rid('ch');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO ff_challenge (id, season, week, scoring_profile_id, status, stake_points, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'open',0, now(), now())`,
      [id, season, week, scoring_profile_id]
    );

    // Optional sides; you can also claim/lock later
    if (home.leagueId && home.teamId) {
      await client.query(
        `INSERT INTO ff_challenge_side
           (challenge_id, side, platform, season, league_id, team_id, team_name)
         VALUES ($1,1,$2,$3,$4,$5,$6)`,
        [
          id,
          home.platform || null,
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
           (challenge_id, side, platform, season, league_id, team_id, team_name)
         VALUES ($1,2,$2,$3,$4,$5,$6)`,
        [
          id,
          away.platform || null,
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
      [rid('che'), id, null, req.body]
    );

    await client.query('COMMIT');
    client.release();

    const challenge = await readChallengeAggregate(id);
    res.status(201).json({ ok: true, challenge });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('challenge create failed', e);
    res.status(500).json({ ok: false, error: 'challenge_create_failed' });
  }
});

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

    res.json({ ok: true, challenges: rows });
  } catch (e) {
    console.error('challenge list failed', e);
    res.status(500).json({ ok: false, error: 'challenge_list_failed' });
  }
});

// GET /api/challenges/:id
router.get('/api/challenges/:id', async (req, res) => {
  try {
    const challenge = await readChallengeAggregate(req.params.id);
    res.json({ ok: true, challenge });
  } catch (e) {
    console.error('challenge get failed', e);
    res.status(500).json({ ok: false, error: 'challenge_get_failed' });
  }
});

// POST /api/challenges/:id/lock
// body: { side: 1|2|'home'|'away', lineup:{starters,bench}, teamName? }
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
    client.release();

    const challenge = await readChallengeAggregate(req.params.id);
    res.json({ ok: true, challenge });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    console.error('challenge score failed', e);
    res.status(500).json({ ok: false, error: 'challenge_score_failed' });
  }
});

module.exports = router;
