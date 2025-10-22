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

const asInt = (v, d=0) => Number.isFinite(+v) ? Math.round(+v) : d;
const posInt = (v) => Math.max(0, asInt(v, 0));
const rid = (p) => `${p}_${crypto.randomUUID().replace(/-/g,'').slice(0,8)}`;

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

// Try a few likely projection sources; gracefully fallback to 0
async function getWeeklyProjection(client, season, week, espnPlayerId) {
  // 1) FantasyPros weekly (if you have it): ff_fp_points_week(season,week,espn_id|player_id, proj_ppr)
  if (await tableExists(client, 'public.ff_fp_points_week')) {
    try {
      const { rows } = await client.query(
        `SELECT proj_ppr AS proj
           FROM ff_fp_points_week
          WHERE season=$1 AND week=$2
            AND (espn_id = $3::bigint OR player_id = $3::bigint)
          ORDER BY proj_ppr DESC
          LIMIT 1`,
        [season, week, espnPlayerId]
      );
      if (rows[0]?.proj != null) return Number(rows[0].proj);
    } catch {}
  }

  // 2) Any cache you keep per week (example): ff_team_points_cache has per-player? If not, skip.

  // 3) Fallback: 0 (pick'em)
  return 0;
}

// A tiny prob model from projection delta (tweak sigma as you like)
function quoteFromProjs(pA, pB) {
  const delta = Number((pA - pB).toFixed(2));
  const favored = (delta === 0) ? 'pick' : (delta > 0 ? 'A' : 'B');
  const line = Math.abs(delta);             // “A by X pts”
  const sigma = 6;                          // spread sensitivity
  const probA = 1 / (1 + Math.exp(-(pA - pB) / sigma));
  const probB = 1 - probA;
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

/* -----------------------------------------------------------
   GET /api/playerh2h/quote
   -> { ok, season, week, playerA:{id,proj}, playerB:{id,proj}, favored, line, probA, probB }
----------------------------------------------------------- */
router.get('/quote', async (req, res) => {
  const season  = asInt(req.query.season, FALLBACK_SEASON);
  const week    = asInt(req.query.week,   FALLBACK_WEEK);
  const playerA = asInt(req.query.playerA);
  const playerB = asInt(req.query.playerB);
  if (!playerA || !playerB) return res.status(400).json({ ok:false, soft:true, error:'bad_args' });

  const client = await pool.connect();
  try {
    const [projA, projB] = await Promise.all([
      getWeeklyProjection(client, season, week, playerA),
      getWeeklyProjection(client, season, week, playerB),
    ]);
    const q = quoteFromProjs(projA, projB);
    return res.json({
      ok: true,
      duel: {
        duel_id: null,                 // not created yet; keep key to satisfy UI+        season, week,
        playerA: { id: playerA, proj: +projA.toFixed(2) },
        playerB: { id: playerB, proj: +projB.toFixed(2) },
      },
      quote: {                         // keep pricing grouped but predictable
        favored: q.favored,
        line: q.line,
        probA: q.probA,
        probB: q.probB,
        delta: q.delta,
        model: 'ppr'
      },
      ts: Date.now()
    });
  } catch (err) {
    console.error('[ph2h/quote] error', err);
    return res.status(500).json({ ok:false, soft:true, error:'server_error' });
  } finally {
    client.release();
  }
});

/* -----------------------------------------------------------
   POST /api/playerh2h/create
   body: { season, week, playerA, playerB, memo? }
   -> { ok, duel_id, status:'open' }
----------------------------------------------------------- */
router.post('/create', express.json(), async (req, res) => {
  const member = getMember(req);
  if (!member) return res.status(401).json({ ok:false, soft:true, error:'unauthorized' });

  const season  = asInt(req.body?.season, FALLBACK_SEASON);
  const week    = asInt(req.body?.week,   FALLBACK_WEEK);
  const playerA = asInt(req.body?.playerA);
  const playerB = asInt(req.body?.playerB);
  const memo    = (req.body?.memo || '').toString().slice(0, 240);

  if (!playerA || !playerB) return res.status(400).json({ ok:false, soft:true, error:'bad_args' });

  const client = await pool.connect();
  try {
    const duel_id = rid('ph2h');
    await client.query(
      `INSERT INTO ff_player_h2h
         (duel_id, season, week, player_a_id, player_b_id, created_by, status, memo)
       VALUES ($1,$2,$3,$4,$5,$6,'open',$7)`,
      [duel_id, season, week, playerA, playerB, member, memo]
    );
    return res.json({
      ok: true,
      duel: {
        duel_id, season, week,
       status: 'open',
        playerA: { id: playerA },
        playerB: { id: playerB },
        memo
      }
    });  } catch (err) {
    console.error('[ph2h/create] error', err);
    return res.status(500).json({ ok:false, soft:true, error:'server_error' });
  } finally {
    client.release();
  }
});

/* -----------------------------------------------------------
   POST /api/playerh2h/wager
   body: { duel_id, side:'A'|'B', amount, memo?, hold_id? }
   - If no hold_id provided, creates a real hold tied to this duel
   -> { ok, duel_id, wager_id, hold_id, pending, pot:{A,B} }
----------------------------------------------------------- */
router.post('/wager', express.json(), async (req, res) => {
  const member = getMember(req);
  if (!member) return res.status(401).json({ ok:false, soft:true, error:'unauthorized' });

  const duel_id = (req.body?.duel_id || '').toString();
  const side    = (req.body?.side || '').toUpperCase();
  const amount  = posInt(req.body?.amount);
  const memo    = (req.body?.memo || '').toString().slice(0,240);
  let   hold_id = (req.body?.hold_id || '').toString();

  if (!duel_id || !['A','B'].includes(side) || !amount)
    return res.status(400).json({ ok:false, soft:true, error:'bad_args' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: drows } = await client.query(
      `SELECT duel_id, status FROM ff_player_h2h WHERE duel_id=$1 FOR UPDATE`,
      [duel_id]
    );
    if (!drows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok:false, soft:true, error:'duel_not_found' }); }
    if (drows[0].status !== 'open') { await client.query('ROLLBACK'); return res.status(409).json({ ok:false, soft:true, error:'duel_not_open' }); }

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
