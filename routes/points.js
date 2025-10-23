// routes/points.js
const router = require('express').Router();
const { Pool } = require('pg');
const { requireMember } = require('./identity/me');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Config
const PPD = Number(process.env.FF_POINTS_PER_DOLLAR || 100); // 100 pts = $1
const HOLD_TTL_MINUTES = Number(process.env.FF_HOLD_TTL_MINUTES || 15);

async function getTotals(memberId) {
  const [{ rows: c1 }, { rows: c2 }] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(points),0)::bigint AS pts FROM ff_points_credits WHERE member_id=$1`, [memberId]),
    pool.query(`
      SELECT COALESCE(SUM(amount_held),0)::bigint AS held
      FROM ff_holds
      WHERE member_id=$1 AND currency='points' AND status='held' AND expires_at > NOW()
    `, [memberId]),
  ]);
  const credits = Number(c1[0]?.pts || 0);
  const held    = Number(c2[0]?.held || 0);
  const available = Math.max(0, credits - held);
  return { credits, held, available, usd: credits / PPD };
}

// GET /api/points/balance -> {ok, points, held, available, usd}
router.get('/balance', requireMember, async (req, res) => {
  try {
    const t = await getTotals(req.member_id);
    return res.json({ ok: true, points: t.credits, held: t.held, available: t.available, usd: t.usd });
  } catch (e) {
    console.error('points.balance.error', e);
    return res.status(400).json({ ok: false, error: e.message });
  }
});

// POST /api/points/hold  (Duels + H2H use this)
router.post('/hold', requireMember, async (req, res) => {
  try {
    const { amount, product='duels-1v1', season, week, scoring, playerA, playerB, memo } = req.body || {};
    const amt = Math.max(0, Math.floor(Number(amount || 0)));
    if (!amt) return res.status(400).json({ ok:false, error:'bad_amount' });

    // Balance check
    const t = await getTotals(req.member_id);
    if (amt > t.available) return res.status(400).json({ ok:false, error:'insufficient_funds', available: t.available });

    // Insert hold
    const { rows } = await pool.query(`
      INSERT INTO ff_holds
        (hold_id, member_id, currency, amount_held, amount_captured, amount_released, status,
         expires_at, scope_type, scope_id, memo, meta, created_at, updated_at)
      VALUES (
        concat('hold_', replace(gen_random_uuid()::text,'-','')),
        $1, 'points', $2, 0, 0, 'held',
        NOW() + ($3 || ' minutes')::interval,
        $4, $5, $6, $7::jsonb, NOW(), NOW()
      )
      RETURNING hold_id, expires_at
    `, [
      req.member_id,
      amt,
      HOLD_TTL_MINUTES,
      product,                      // scope_type
      (playerA && playerB) ? `${playerA}_${playerB}` : null, // scope_id
      memo || `${product}:${season||''}:${week||''}:${scoring||''}:${playerA||''}vs${playerB||''}`,
      JSON.stringify({ season, week, scoring, playerA, playerB })
    ]);

    return res.json({ ok:true, hold_id: rows[0].hold_id, expires_at: rows[0].expires_at });
  } catch (e) {
    console.error('points.hold.error', e);
    return res.status(400).json({ ok:false, error:e.message });
  }
});

// (Optional) release timed-out holds: POST /api/points/release-expired
router.post('/release-expired', async (_req, res) => {
  try {
    const { rowCount } = await pool.query(`
      UPDATE ff_holds
      SET status='released', amount_released=amount_held, released_at=NOW(), updated_at=NOW()
      WHERE status='held' AND expires_at < NOW()
    `);
    return res.json({ ok:true, released: rowCount });
  } catch (e) {
    console.error('points.release_expired.error', e);
    return res.status(400).json({ ok:false, error:e.message });
  }
});

// (Optional) capture a hold after result settles
// body: { hold_id, winner:boolean, payout_points?:number, house_member?:'HOUSE' }
router.post('/capture', async (req, res) => {
  const { hold_id, winner, payout_points=0, house_member='HOUSE', memo } = req.body || {};
  if (!hold_id) return res.status(400).json({ ok:false, error:'missing_hold_id' });

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');

    const { rows: hrows } = await cli.query(
      `SELECT * FROM ff_holds WHERE hold_id=$1 FOR UPDATE`, [hold_id]
    );
    const h = hrows[0];
    if (!h) throw new Error('hold_not_found');
    if (h.status !== 'held') throw new Error('invalid_status');

    // 1) mark captured
    await cli.query(
      `UPDATE ff_holds SET status='captured', amount_captured=amount_held, captured_at=NOW(), updated_at=NOW() WHERE hold_id=$1`,
      [hold_id]
    );

    // 2) if winner, credit payout (includes stake + winnings based on your model); if loser, nothing goes back
    if (winner && payout_points > 0) {
      await cli.query(
        `INSERT INTO ff_points_credits (member_id, source, source_id, points)
         VALUES ($1, 'duels', $2, $3)
         ON CONFLICT (source, source_id) DO NOTHING`,
        [h.member_id, `${hold_id}:payout`, Math.floor(payout_points)]
      );
    }

    // 3) optional house rake
    if (memo) {
      await cli.query(
        `INSERT INTO ff_points_credits (member_id, source, source_id, points)
         VALUES ($1, 'duels', $2, $3)
         ON CONFLICT (source, source_id) DO NOTHING`,
        [house_member, `${hold_id}:rake`, Math.max(0, Math.floor((h.amount_held*2) - payout_points))]
      );
    }

    await cli.query('COMMIT');
    return res.json({ ok:true });
  } catch (e) {
    await cli.query('ROLLBACK');
    console.error('points.capture.error', e);
    return res.status(400).json({ ok:false, error:e.message });
  } finally {
    cli.release();
  }
});

module.exports = router;
