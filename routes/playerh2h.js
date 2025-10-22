// routes/playerh2h.js
const express = require('express');
const crypto  = require('crypto');
const { Pool } = require('pg');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const FALLBACK_SEASON = Number(process.env.FF_CURRENT_SEASON || new Date().getFullYear());
const FALLBACK_WEEK   = Number(process.env.FF_CURRENT_WEEK   || 1);

// which columns to try for each scoring flavor (in order)
const SCORE_COL = {
  PPR:  ['proj_ppr','ppr','proj'],
  HALF: ['proj_half','half'],
  STD:  ['proj_std','std']
};

const asInt  = (v, d=0) => Number.isFinite(+v) ? Math.round(+v) : d;
const asId   = (v) => v == null ? null : String(v).trim();
const posInt = (v) => Math.max(0, asInt(v, 0));
const rid    = (p) => `${p}_${crypto.randomUUID().replace(/-/g,'').slice(0,8)}`;

const getMember = (req) =>
  req.headers['x-ff-member'] ||
  req.headers['x-member-id'] ||
  req.cookies?.ff_member_id ||
  req.cookies?.member_id || null;

/* -----------------------------------------------------------
   Helpers: projections + safe table checks
----------------------------------------------------------- */
async function tableExists(client, qname) {
  const { rows } = await client.query(`SELECT to_regclass($1) AS t`, [qname]);
  return !!rows[0]?.t;
}

// Try multiple tables/columns; return first numeric projection we find
// 1) exact season+week; 2) nearest available week within season
async function getWeeklyProjection(client, season, week, espnPlayerId, scoring='PPR') {
  const cols = SCORE_COL[String(scoring).toUpperCase()] || SCORE_COL.PPR;
  const id   = String(espnPlayerId);

  const tryQ = async (sql, params) => {
    try { const { rows } = await client.query(sql, params); return rows?.[0]?.proj; }
    catch { return null; }
  };

  const pickCol = async (table, idCols) => {
    for (const c of cols) {
      const whereId = idCols.map(ic => `${ic}::text = $3::text`).join(' OR ');

      const sqlExact = `
        SELECT ${c} AS proj FROM ${table}
        WHERE season=$1 AND week=$2 AND (${whereId}) AND ${c} IS NOT NULL
        ORDER BY ${c} DESC LIMIT 1`;
      const vExact = await tryQ(sqlExact, [season, week, id]);
      if (vExact != null && isFinite(vExact)) return Number(vExact);

      const sqlNearest = `
        SELECT ${c} AS proj FROM ${table}
        WHERE season=$1 AND (${whereId}) AND ${c} IS NOT NULL AND week IS NOT NULL
        ORDER BY CASE WHEN week=$2 THEN 0 ELSE ABS(week - $2) END ASC
        LIMIT 1`;
      const vNear = await tryQ(sqlNearest, [season, week, id]);
      if (vNear != null && isFinite(vNear)) return Number(vNear);
    }
    return null;
  };

  if (await tableExists(client, 'public.ff_fp_points_week')) {
    const v = await pickCol('ff_fp_points_week', ['espn_id','espn_player_id','player_id']);
    if (v != null) return v;
  }
  if (await tableExists(client, 'public.ff_espn_week_proj')) {
    const v = await pickCol('ff_espn_week_proj', ['espn_id','espn_player_id','player_id']);
    if (v != null) return v;
  }
  if (await tableExists(client, 'public.ff_player_week_proj')) {
    const v = await pickCol('ff_player_week_proj', ['espn_id','espn_player_id','player_id']);
    if (v != null) return v;
  }
  for (const t of ['public.fp_week_proj','public.week_proj','public.player_week_proj']) {
    if (await tableExists(client, t)) {
      let v = await tryQ(
        `SELECT proj FROM ${t}
         WHERE season=$1 AND week=$2
           AND (espn_id::text=$3::text OR espn_player_id::text=$3::text OR player_id::text=$3::text)
           AND proj IS NOT NULL
         ORDER BY proj DESC LIMIT 1`,
        [season, week, id]
      );
      if (v != null && isFinite(v)) return Number(v);

      v = await tryQ(
        `SELECT proj FROM ${t}
         WHERE season=$1
           AND (espn_id::text=$2::text OR espn_player_id::text=$2::text OR player_id::text=$2::text)
           AND proj IS NOT NULL AND week IS NOT NULL
         ORDER BY CASE WHEN week=$3 THEN 0 ELSE ABS(week - $3) END ASC
         LIMIT 1`,
        [season, id, week]
      );
      if (v != null && isFinite(v)) return Number(v);
    }
  }
  return 0;
}

// Prob model from projection delta
function quoteFromProjs(pA, pB) {
  const delta   = Number((pA - pB).toFixed(2));
  const favored = (delta === 0) ? 'pick' : (delta > 0 ? 'A' : 'B');
  const line    = Math.abs(delta);
  const sigma   = 6;
  const probA   = 1 / (1 + Math.exp(-(pA - pB) / sigma));
  const probB   = 1 - probA;
  return { favored, line, probA: +probA.toFixed(3), probB: +probB.toFixed(3), delta };
}

// Create a real hold tied to this duel (scope_type/playerh2h)
async function createHold(client, { member_id, amount, memo, duel_id }) {
  const ttl = 15 * 60; // 15 minutes
  const hold_id = 'hold_' + crypto.randomUUID().replace(/-/g,'').slice(0,16);
  await client.query(
    `INSERT INTO ff_holds
       (hold_id, member_id, currency, amount_held, status, expires_at, scope_type, scope_id, memo)
     VALUES ($1,$2,'points',$3,'held', (now() + ($4::int) * INTERVAL '1 second'), 'playerh2h', $5, $6)`,
    [hold_id, member_id, amount, ttl, duel_id, memo || 'Player H2H wager']
  );
  return hold_id;
}

// If duel_id is synthetic like "syn_<A>_<B>_<season>_<week>", ensure there is a row
async function ensureSynDuel(client, duel_id, created_by) {
  if (!duel_id || !duel_id.startsWith('syn_')) return;
  const m = /^syn_(\d+)_(\d+)_(\d{4})_(\d{1,2})$/.exec(duel_id);
  if (!m) return;
  const [, a, b, s, w] = m;
  await client.query(
    `INSERT INTO ff_player_h2h
       (duel_id, season, week, player_a_id, player_b_id, created_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,'open')
     ON CONFLICT (duel_id) DO NOTHING`,
    [duel_id, asInt(s, FALLBACK_SEASON), asInt(w, FALLBACK_WEEK), asInt(a, 0), asInt(b, 0), created_by || 'system']
  );
}

/* -----------------------------------------------------------
   GET /api/playerh2h/quote
----------------------------------------------------------- */
router.get('/quote', async (req, res) => {
  const season  = asInt(req.query.season, FALLBACK_SEASON);
  const week    = asInt(req.query.week,   FALLBACK_WEEK);
  const playerA = asId(req.query.playerA);
  const playerB = asId(req.query.playerB);
  const scoring = (req.query.scoring || 'PPR').toString().toUpperCase(); // STD|HALF|PPR

  if (!playerA || !playerB)
    return res.status(400).json({ ok:false, soft:true, error:'bad_args' });

  const client = await pool.connect();
  try {
    const [projA, projB] = await Promise.all([
      getWeeklyProjection(client, season, week, playerA, scoring),
      getWeeklyProjection(client, season, week, playerB, scoring),
    ]);
    const q = quoteFromProjs(projA, projB);

    const body = {
      ok: true,
      duel: {
        duel_id: null, // not created yet; keep key to satisfy UI
        season, week,
        playerA: { id: playerA, proj: +projA.toFixed(2) },
        playerB: { id: playerB, proj: +projB.toFixed(2) },
      },
      quote: {
        favored: q.favored,
        line: q.line,
        probA: q.probA,
        probB: q.probB,
        delta: q.delta,
        model: scoring.toLowerCase(),
      },
      ts: Date.now()
    };

    // legacy mirrors
    body.favored = body.quote.favored;
    body.line    = body.quote.line;
    body.probA   = body.quote.probA;
    body.probB   = body.quote.probB;
    body.delta   = body.quote.delta;
    body.projA   = body.duel.playerA.proj;
    body.projB   = body.duel.playerB.proj;

    return res.json(body);
  } catch (err) {
    console.error('[ph2h/quote] error', err);
    return res.status(500).json({ ok:false, soft:true, error:'server_error' });
  } finally {
    client.release();
  }
});

/* -----------------------------------------------------------
   POST /api/playerh2h/create
----------------------------------------------------------- */
router.post('/create', express.json(), async (req, res) => {
  const member = getMember(req);
  if (!member) return res.status(401).json({ ok:false, soft:true, error:'unauthorized' });

  const season  = asInt(req.body?.season, FALLBACK_SEASON);
  const week    = asInt(req.body?.week,   FALLBACK_WEEK);
  const playerA = asId(req.body?.playerA);
  const playerB = asId(req.body?.playerB);
  const memo    = (req.body?.memo || '').toString().slice(0, 240);

  if (!playerA || !playerB) return res.status(400).json({ ok:false, soft:true, error:'bad_args' });

  const client = await pool.connect();
  try {
    const duel_id = rid('ph2h');
    await client.query(
      `INSERT INTO ff_player_h2h
         (duel_id, season, week, player_a_id, player_b_id, created_by, status, memo)
       VALUES ($1,$2,$3,$4,$5,$6,'open',$7)`,
      [duel_id, season, week, asInt(playerA), asInt(playerB), member, memo]
    );

    return res.json({
      ok: true,
      duel: {
        duel_id,
        season,
        week,
        status: 'open',
        playerA: { id: playerA },
        playerB: { id: playerB },
        memo
      }
    });
  } catch (err) {
    console.error('[ph2h/create] error', err);
    return res.status(500).json({ ok:false, soft:true, error:'server_error' });
  } finally {
    client.release();
  }
});

/* -----------------------------------------------------------
   POST /api/playerh2h/wager
   Accepts: { duel_id, side:'A'|'B', amount? | stake_points?, memo?, hold_id? }
----------------------------------------------------------- */
router.post('/wager', express.json(), async (req, res) => {
  const member = getMember(req);
  if (!member) return res.status(401).json({ ok:false, soft:true, error:'unauthorized' });

  let duel_id = asId(req.body?.duel_id || req.body?.duelId || req.body?.duel);
  const side  = (req.body?.side || req.body?.pick || req.body?.choice || '').toString().toUpperCase();

  // Support aliases for the wager amount
  const amount = posInt(
    req.body?.amount ??
    req.body?.stake_points ??
    req.body?.stakePoints ??
    req.body?.stake ??
    req.body?.points
  );

  const memo    = (req.body?.memo || '').toString().slice(0,240);
  let   hold_id = (req.body?.hold_id || req.body?.holdId || '').toString();

  if (!duel_id || !['A','B'].includes(side) || !amount) {
    return res.status(400).json({ ok:false, soft:true, error:'bad_args' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // If it's a synthetic ID, upsert the duel row
    await ensureSynDuel(client, duel_id, member);

    const { rows: drows } = await client.query(
      `SELECT duel_id, status FROM ff_player_h2h WHERE duel_id=$1 FOR UPDATE`,
      [duel_id]
    );
    if (!drows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok:false, soft:true, error:'duel_not_found' });
    }
    if (drows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok:false, soft:true, error:'duel_not_open' });
    }

    // Create a real hold if one wasn't provided
    if (!hold_id) {
      hold_id = await createHold(client, { member_id: member, amount, memo, duel_id });
    }

    const wager_id = rid('phw');
    await client.query(
      `INSERT INTO ff_player_h2h_wager
         (wager_id, duel_id, member_id, side, amount, hold_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,'held')`,
      [wager_id, duel_id, member, side, amount, hold_id]
    );

    // update open pots
    const col = (side === 'A') ? 'pot_a' : 'pot_b';
    await client.query(
      `UPDATE ff_player_h2h SET ${col} = ${col} + $2 WHERE duel_id=$1`,
      [duel_id, amount]
    );

    const { rows: pots } = await client.query(
      `SELECT pot_a, pot_b FROM ff_player_h2h WHERE duel_id=$1`, [duel_id]
    );

    await client.query('COMMIT');
    return res.json({
      ok: true,
      duel: {
        duel_id,
        pot: { A: pots[0].pot_a, B: pots[0].pot_b }
      },
      wager: {
        wager_id,
        side,
        amount,
        hold_id,
        status: 'held'
      },
      pending: amount
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ph2h/wager] error', err);
    return res.status(500).json({ ok:false, soft:true, error:'server_error' });
  } finally {
    client.release();
  }
});

module.exports = router;
