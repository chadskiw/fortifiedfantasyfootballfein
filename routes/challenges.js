// routes/challenges.js
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const rid = (p='ch') => `${p}_${crypto.randomUUID().replace(/-/g,'').slice(0,18)}`;

// POST /api/challenges  (create)
router.post('/', async (req, res) => {
  const { season, week, scoring_profile_id = 'inherit', home, away } = req.body || {};
  if (!season || !week || !home?.leagueId || !home?.teamId || !away?.leagueId || !away?.teamId) {
    return res.status(400).json({ ok:false, error:'invalid_payload' });
  }
  const id = rid('ch');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO ff_challenge (id, season, week, scoring_profile_id, status)
       VALUES ($1,$2,$3,$4,'pending')`,
      [id, Number(season), Number(week), scoring_profile_id]
    );
    // side 1 (home)
    await client.query(
      `INSERT INTO ff_challenge_side
         (id, challenge_id, side, platform, season, league_id, team_id, team_name, owner_member_id)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8)`,
      [
        rid('chs'),
        id,
        home.platform || 'espn',
        Number(season),
        String(home.leagueId),
        String(home.teamId),
        home.teamName || null,
        (req.user && req.user.member_id) || null
      ]
    );
    // side 2 (away)
    await client.query(
      `INSERT INTO ff_challenge_side
         (id, challenge_id, side, platform, season, league_id, team_id, team_name, owner_member_id)
       VALUES ($1,$2,2,$3,$4,$5,$6,$7,$8)`,
      [
        rid('chs'),
        id,
        away.platform || 'espn',
        Number(season),
        String(away.leagueId),
        String(away.teamId),
        away.teamName || null,
        away.owner_member_id || null
      ]
    );

    await client.query(
      `INSERT INTO ff_challenge_event (id, challenge_id, actor_member_id, type, data)
       VALUES ($1,$2,$3,'create',$4)`,
      [rid('che'), id, (req.user && req.user.member_id) || null, req.body]
    );

    await client.query('COMMIT');

    const { rows } = await pool.query(
      `SELECT c.*, 
              jsonb_agg(jsonb_build_object(
                'side', s.side,
                'platform', s.platform, 'season', s.season,
                'league_id', s.league_id, 'team_id', s.team_id,
                'team_name', s.team_name, 'locked_at', s.locked_at,
                'points_final', s.points_final
              ) ORDER BY s.side) AS sides
       FROM ff_challenge c
       JOIN ff_challenge_side s ON s.challenge_id = c.id
       WHERE c.id=$1
       GROUP BY c.id`,
      [id]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('create challenge failed', e);
    res.status(500).json({ ok:false, error:'challenge_create_failed' });
  } finally {
    client.release();
  }
});

// GET /api/challenges?season=&leagueId=&teamId=
router.get('/', async (req, res) => {
  const { season, leagueId, teamId } = req.query;
  try {
    const params = [];
    let where = [];
    if (season) { params.push(Number(season)); where.push(`c.season = $${params.length}`); }
    if (leagueId && teamId) {
      params.push(String(leagueId), String(teamId));
      where.push(`EXISTS (SELECT 1 FROM ff_challenge_side s WHERE s.challenge_id = c.id AND s.league_id = $${params.length-1} AND s.team_id = $${params.length})`);
    }
    const sql = `
      SELECT c.*,
             jsonb_agg(jsonb_build_object(
               'side', s.side, 'platform', s.platform, 'season', s.season, 'league_id', s.league_id,
               'team_id', s.team_id, 'team_name', s.team_name, 'locked_at', s.locked_at, 'points_final', s.points_final
             ) ORDER BY s.side) AS sides
      FROM ff_challenge c
      JOIN ff_challenge_side s ON s.challenge_id = c.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 200`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:'challenge_list_failed' });
  }
});

// GET /api/challenges/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              jsonb_agg(jsonb_build_object(
                'side', s.side, 'platform', s.platform, 'season', s.season, 'league_id', s.league_id,
                'team_id', s.team_id, 'team_name', s.team_name, 'locked_at', s.locked_at, 'points_final', s.points_final,
                'lineup_json', s.lineup_json, 'bench_json', s.bench_json
              ) ORDER BY s.side) AS sides
       FROM ff_challenge c
       JOIN ff_challenge_side s ON s.challenge_id = c.id
       WHERE c.id=$1
       GROUP BY c.id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok:false, error:'challenge_not_found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:'challenge_get_failed' });
  }
});

// POST /api/challenges/:id/lock   { side: 1|2, lineup: {starters:[], bench:[]}, teamName? }
router.post('/:id/lock', async (req, res) => {
  const { side, lineup = {}, bench = null, teamName } = req.body || {};
  if (![1,2,'1','2'].includes(side)) return res.status(400).json({ ok:false, error:'invalid_side' });

  try {
    const { rowCount } = await pool.query(
      `UPDATE ff_challenge_side
       SET lineup_json = $1, bench_json = $2, locked_at = now(), team_name = COALESCE($3, team_name)
       WHERE challenge_id = $4 AND side = $5`,
      [lineup, bench, teamName || null, req.params.id, Number(side)]
    );
    if (!rowCount) return res.status(404).json({ ok:false, error:'challenge_side_not_found' });

    await pool.query(
      `INSERT INTO ff_challenge_event (id, challenge_id, actor_member_id, type, data)
       VALUES ($1,$2,$3,'lock',$4)`,
      [rid('che'), req.params.id, (req.user && req.user.member_id) || null, { side, count: (lineup?.starters||[]).length }]
    );

    const { rows } = await pool.query(`SELECT * FROM ff_challenge_side WHERE challenge_id=$1 ORDER BY side`, [req.params.id]);
    res.json({ ok:true, sides: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:'challenge_lock_failed' });
  }
});

// POST /api/challenges/:id/score  (server sums pts from lineup_json.starters[].pts)
router.post('/:id/score', async (req, res) => {
  try {
    const client = await pool.connect();
    await client.query('BEGIN');

    const { rows: sides } = await client.query(`SELECT * FROM ff_challenge_side WHERE challenge_id=$1 ORDER BY side`, [req.params.id]);
    if (sides.length !== 2) { await client.query('ROLLBACK'); return res.status(400).json({ ok:false, error:'invalid_challenge' }); }

    const sum = (arr) => (Array.isArray(arr) ? arr.reduce((n,p)=> n + (Number(p?.pts ?? p?.points ?? 0)), 0) : 0);

    let h = sides.find(s => s.side === 1);
    let a = sides.find(s => s.side === 2);

    const hp = sum(h?.lineup_json?.starters);
    const ap = sum(a?.lineup_json?.starters);

    await client.query(`UPDATE ff_challenge_side SET points_final=$1 WHERE id=$2`, [hp, h.id]);
    await client.query(`UPDATE ff_challenge_side SET points_final=$1 WHERE id=$2`, [ap, a.id]);
    await client.query(`UPDATE ff_challenge SET status='final', updated_at=now() WHERE id=$1`, [req.params.id]);

    await client.query(
      `INSERT INTO ff_challenge_event (id, challenge_id, actor_member_id, type, data)
       VALUES ($1,$2,$3,'score',$4)`,
      [rid('che'), req.params.id, (req.user && req.user.member_id) || null, { hp, ap }]
    );

    await client.query('COMMIT');

    const { rows } = await pool.query(
      `SELECT c.*,
              jsonb_agg(jsonb_build_object(
                'side', s.side, 'platform', s.platform, 'season', s.season, 'league_id', s.league_id,
                'team_id', s.team_id, 'team_name', s.team_name, 'locked_at', s.locked_at, 'points_final', s.points_final
              ) ORDER BY s.side) AS sides
       FROM ff_challenge c
       JOIN ff_challenge_side s ON s.challenge_id = c.id
       WHERE c.id=$1
       GROUP BY c.id`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:'challenge_score_failed' });
  }
});

module.exports = router;
