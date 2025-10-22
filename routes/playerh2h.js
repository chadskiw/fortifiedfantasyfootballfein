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

// Column candidates per scoring flavor (order matters)
const SCORE_COL = {
  PPR:  ['proj_ppr','ppr','proj'],
  HALF: ['proj_half','half'],
  STD:  ['proj_std','std'],
};

// If your FEIN schema already exposes a projection function, we prefer it.
// We'll try these (in order) and gracefully fall back if undefined:
const PROJ_FUNC_SQLS = [
  'SELECT fein_weekly_proj($1,$2,$3::text,$4) AS proj',       // if you already have it in FEIN
  'SELECT ff_weekly_proj($1,$2,$3::text,$4)  AS proj',        // optional function name you might adopt
  'SELECT ff_calc_weekly_proj($1,$2,$3::text,$4) AS proj',    // alternate naming
];

const BAD_TOKENS = new Set([null, undefined, '', 'undefined', 'null', 'NaN']);
const asId  = (v) => {
  const s = (v ?? '').toString().trim();
  return BAD_TOKENS.has(s) ? null : s;
};
const asInt = (v, d=0) => {
  const s = (v ?? '').toString().trim();
  if (BAD_TOKENS.has(s)) return d;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : d;
};
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

async function colExists(client, table, col) {
  const { rows } = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2
      LIMIT 1`,
    [table.replace(/^public\./,''), col]
  );
  return !!rows.length;
}

// 1) Prefer existing FEIN function(s) if present.
// 2) Otherwise: scan likely tables/columns by scoring flavor.
//    - exact (season,week) first; then nearest week in same season.
//
// Returns a Number >= 0, default 0 when nothing found.
async function getWeeklyProjection(client, season, week, espnPlayerId, scoring='PPR') {
  const id   = String(espnPlayerId);
  const cols = SCORE_COL[String(scoring).toUpperCase()] || SCORE_COL.PPR;

  // Try known functions first
  for (const sql of PROJ_FUNC_SQLS) {
    try {
      const { rows } = await client.query(sql, [season, week, id, scoring.toUpperCase()]);
      const v = rows?.[0]?.proj;
      if (v != null && isFinite(Number(v))) return Number(v);
    } catch (e) {
      // 42883 = undefined_function; ignore and try next
      if (e && e.code && e.code !== '42883') {
        // Other DB errors—fall through to table strategy
      }
    }
  }

  // Fallback: table strategy
  // Add/arrange tables to reflect your warehouse (FEIN uses something akin to these).
  const candidateTables = [
    'public.ff_fp_points_week',     // FantasyPros import
    'public.ff_espn_week_proj',     // ESPN derived
    'public.ff_player_week_proj',   // canonical weekly
    'public.fp_week_proj',          // generic
    'public.week_proj',
    'public.player_week_proj',
  ];

  // Helper to select by (season,week,id) using ::text id compare
  const selectBy = async (table) => {
    // Find an ID column that exists in this table
    const idColsPref = ['espn_id','espn_player_id','player_id'];
    const idCols = [];
    for (const c of idColsPref) {
      if (await colExists(client, table, c)) idCols.push(c);
    }
    if (!idCols.length) return null;

    const whereId = idCols.map(ic => `${ic}::text = $3::text`).join(' OR ');

    // Try scoring columns in order
    for (const c of cols) {
      if (!(await colExists(client, table, c))) continue;

      // exact week
      try {
        const { rows } = await client.query(
          `SELECT ${c} AS proj
             FROM ${table}
            WHERE season=$1 AND week=$2 AND (${whereId}) AND ${c} IS NOT NULL
            ORDER BY ${c} DESC
            LIMIT 1`,
          [season, week, id]
        );
        const v = rows?.[0]?.proj;
        if (v != null && isFinite(Number(v))) return Number(v);
      } catch {}

      // nearest week (if exact missing)
      try {
        const { rows } = await client.query(
          `SELECT ${c} AS proj
             FROM ${table}
            WHERE season=$1 AND (${whereId})
              AND ${c} IS NOT NULL AND week IS NOT NULL
            ORDER BY CASE WHEN week=$2 THEN 0 ELSE ABS(week - $2) END ASC
            LIMIT 1`,
          [season, week, id]
        );
        const v = rows?.[0]?.proj;
        if (v != null && isFinite(Number(v))) return Number(v);
      } catch {}
    }
    return null;
  };

  for (const t of candidateTables) {
    if (await tableExists(client, t)) {
      const v = await selectBy(t);
      if (v != null) return v;
    }
  }

  return 0; // pick'em fallback
}

// Tiny prob model from projection delta
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
        playerA: { id: playerA, proj: +Number(projA).toFixed(2) },
        playerB: { id: playerB, proj: +Number(projB).toFixed(2) },
      },
      quote: {
        favored: q.favored,
        line: q.line,
        probA: q.probA,
        probB: q.probB,
        delta: q.delta,
        model: scoring.toLowerCase(),
      },
      ts: Date.now(),
    };

    // Legacy mirrors so existing FE keeps working
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

  // aliases for the wager amount
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

    // Upsert if synthetic ID
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
