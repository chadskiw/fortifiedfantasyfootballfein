// routes/duels.js
const router = require('express').Router();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const HOUSE_ID = process.env.FF_HOUSE_MEMBER || 'HOUSE';
const DEFAULT_HOUSE_RATE = Number(process.env.FF_DUELS_HOUSE_RATE || 0.045);
const HOLD_TTL_MIN = Number(process.env.FF_HOLD_TTL_MINUTES || 15);

// --- helpers (same pattern as h2h) ---
async function withTx(fn){ const c = await pool.connect(); try{ await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; } catch(e){ await c.query('ROLLBACK'); throw e; } finally{ c.release(); } }
async function getMemberId(req){
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  const base  = new URL(req.originalUrl || '/', `${proto}://${host}`);
  const meUrl = new URL('../identity/me', base);
  const r = await fetch(meUrl, { headers:{ cookie: req.headers.cookie || '' }});
  if(!r.ok) throw new Error('not_authenticated');
  const me = await r.json();
  const id = me.member_id || me.memberId || me.identity?.member_id || me.identity?.memberId;
  if(!id) throw new Error('not_authenticated');
  return String(id);
}
async function availablePoints(cli, memberId){
  const { rows:[w] } = await cli.query(`
    WITH ledger AS (SELECT COALESCE(SUM(delta_points),0) AS total FROM ff_points_credits WHERE member_id=$1),
         holds  AS (SELECT COALESCE(SUM(amount_held),0)   AS held  FROM ff_holds WHERE member_id=$1 AND status='held' AND expires_at > NOW())
    SELECT (ledger.total - holds.held) AS available FROM ledger, holds
  `, [memberId]);
  return Number(w?.available || 0);
}
const idemKey = (o)=> crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0,40);
const newId   = (p)=> `${p}_${crypto.randomBytes(9).toString('hex')}`;

// ==============================
// POST /api/duels/offer
// body: { season, week, scoring, playerA, playerB, amount }
// Creates duel + first hold; status=pending
// ==============================
router.post('/offer', async (req,res)=>{
  try{
    const memberId = await getMemberId(req);
    const { season, week, scoring='PPR', playerA, playerB, amount } = req.body || {};
    const stake = Math.max(0, Number(amount||0));
    if(!season || !week || !playerA || !playerB || !stake) return res.status(400).json({ ok:false, error:'missing_args' });

    const out = await withTx(async cli=>{
      const avail = await availablePoints(cli, memberId);
      if (avail < stake) throw new Error('insufficient_funds');

      const duelId = newId('duel');
      const sideAId = newId('dls'); const sideBId = newId('dls');

      // parent
      await cli.query(`
        INSERT INTO ff_duel (id, season, week, scoring, status, stake_points, created_by_member_id, updated_at, created_at)
        VALUES ($1,$2,$3,$4,'pending',$5,$6,NOW(),NOW())
      `, [duelId, season, week, String(scoring).toUpperCase(), stake, memberId]);

      // sides (A is the offerer by default)
      await cli.query(`
        INSERT INTO ff_duel_side (id, duel_id, side, player_id, player_name, claimed_by_member_id, claimed_at, updated_at)
        VALUES
          ($1,$3,1,$5,$6,$7,NOW(),NOW()),
          ($2,$3,2,$8,$9,NULL,NULL,NOW())
      `, [sideAId, sideBId, duelId, /*skip*/ null, String(playerA), null, memberId, String(playerB), null]);

      // hold for offerer
      const memo = `duel:${duelId}:A`;
      const holdId = crypto.randomUUID();
      await cli.query(`
        INSERT INTO ff_holds (hold_id, member_id, currency, amount_held, status, memo, expires_at, created_at, updated_at)
        VALUES ($1,$2,'points',$3,'held',$4, NOW() + ($5 || ' minutes')::interval, NOW(), NOW())
      `, [holdId, memberId, stake, memo, String(HOLD_TTL_MIN)]);

      await cli.query(`UPDATE ff_duel_side SET hold_id=$1 WHERE id=$2`, [holdId, sideAId]);

      return { duel_id: duelId, status:'pending', hold_id: holdId };
    });

    res.json({ ok:true, ...out });
  }catch(e){
    console.error('duels.offer', e);
    res.status(400).json({ ok:false, error:e.message });
  }
});

// ==============================
// POST /api/duels/accept
// body: { duel_id }
// Claims the open side, creates 2nd hold; status=locked
// ==============================
router.post('/accept', async (req,res)=>{
  try{
    const memberId = await getMemberId(req);
    const { duel_id } = req.body || {};
    if(!duel_id) return res.status(400).json({ ok:false, error:'missing_args' });

    const out = await withTx(async cli=>{
      const { rows:[duel] } = await cli.query(`SELECT id, status, stake_points FROM ff_duel WHERE id=$1 FOR UPDATE`, [duel_id]);
      if(!duel) throw new Error('duel_not_found');
      if(duel.status === 'locked') throw new Error('already_locked');
      if(duel.stake_points <= 0) throw new Error('invalid_stake');

      const { rows:sides } = await cli.query(`SELECT id, side, claimed_by_member_id FROM ff_duel_side WHERE duel_id=$1 FOR UPDATE`, [duel_id]);
      const open = sides.find(s=>!s.claimed_by_member_id);
      if(!open) throw new Error('no_open_side');
      if(sides.some(s=>String(s.claimed_by_member_id) === String(memberId))) throw new Error('already_in');

      const avail = await availablePoints(cli, memberId);
      if (avail < duel.stake_points) throw new Error('insufficient_funds');

      const memo = `duel:${duel_id}:${open.side===1?'A':'B'}`;
      const holdId = crypto.randomUUID();
      await cli.query(`
        INSERT INTO ff_holds (hold_id, member_id, currency, amount_held, status, memo, expires_at, created_at, updated_at)
        VALUES ($1,$2,'points',$3,'held',$4, NOW() + ($5 || ' minutes')::interval, NOW(), NOW())
      `, [holdId, memberId, duel.stake_points, memo, String(HOLD_TTL_MIN)]);

      await cli.query(`UPDATE ff_duel_side SET claimed_by_member_id=$1, claimed_at=NOW(), hold_id=$2, updated_at=NOW() WHERE id=$3`, [memberId, holdId, open.id]);
      await cli.query(`UPDATE ff_duel SET status='locked', updated_at=NOW() WHERE id=$1`, [duel_id]);
      await cli.query(`UPDATE ff_duel_side SET locked_at=NOW(), updated_at=NOW() WHERE duel_id=$1`, [duel_id]);

      return { status:'locked', hold_id: holdId };
    });

    res.json({ ok:true, ...out });
  }catch(e){
    console.error('duels.accept', e);
    res.status(400).json({ ok:false, error:e.message });
  }
});

// ==============================
// GET /api/duels/:id
// ==============================
router.get('/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { rows:[duel] } = await pool.query(`SELECT id, season, week, scoring, status, stake_points, created_by_member_id, updated_at FROM ff_duel WHERE id=$1`, [id]);
    if(!duel) return res.status(404).json({ ok:false, error:'not_found' });
    const { rows:sides } = await pool.query(`SELECT side, player_id, player_name, claimed_by_member_id, hold_id, locked_at FROM ff_duel_side WHERE duel_id=$1 ORDER BY side`, [id]);
    res.json({ ok:true, duel: { ...duel, sides } });
  }catch(e){ res.status(400).json({ ok:false, error:e.message }); }
});

// ==============================
// GET /api/duels/my?states=pending,locked
// ==============================
router.get('/my/list', async (req,res)=>{
  try{
    const memberId = await getMemberId(req);
    const states = String(req.query.states||'pending,locked').split(',').map(s=>s.trim());
    const { rows } = await pool.query(`
      SELECT d.id, d.season, d.week, d.scoring, d.status, d.stake_points, d.updated_at,
             jsonb_agg(jsonb_build_object('side', s.side, 'player_id', s.player_id, 'player_name', s.player_name, 'claimed_by_member_id', s.claimed_by_member_id) ORDER BY s.side) AS sides
      FROM ff_duel d
      JOIN ff_duel_side s ON s.duel_id = d.id
      WHERE d.status = ANY($1::text[])
        AND EXISTS (SELECT 1 FROM ff_duel_side sx WHERE sx.duel_id=d.id AND sx.claimed_by_member_id=$2)
      GROUP BY d.id
      ORDER BY d.updated_at DESC
      LIMIT 100
    `, [states, memberId]);
    res.json({ ok:true, items: rows });
  }catch(e){ res.status(400).json({ ok:false, error:e.message }); }
});

// ==============================
// POST /api/duels/settle
// body: { duel_id, winner: 'A'|'B' }
// ==============================
router.post('/settle', async (req,res)=>{
  const { duel_id, winner } = req.body || {};
  if(!duel_id || !['A','B'].includes(String(winner||'').toUpperCase())) return res.status(400).json({ ok:false, error:'missing_args' });

  const cli = await pool.connect();
  try{
    await cli.query('BEGIN');

    const tagA = `duel:${duel_id}:A`;
    const tagB = `duel:${duel_id}:B`;
    const { rows: holds } = await cli.query(`SELECT * FROM ff_holds WHERE status='held' AND memo IN ($1,$2) FOR UPDATE`, [tagA, tagB]);
    if(holds.length < 2) throw new Error('holds_not_found');
    const A = holds.find(h=>h.memo.endsWith(':A'));
    const B = holds.find(h=>h.memo.endsWith(':B'));
    if(!A || !B) throw new Error('both_sides_required');

    await cli.query(`UPDATE ff_holds SET status='captured', amount_captured=amount_held, captured_at=NOW(), updated_at=NOW() WHERE hold_id = ANY($1::text[])`, [[A.hold_id, B.hold_id]]);

    // ledger debits
    const stakeCap = async (h)=> cli.query(`
      INSERT INTO ff_points_ledger (member_id, currency, delta_points, kind, source, source_id, ref_type, ref_id, memo, idempotency_key)
      VALUES ($1,'points',$2,'stake_captured_duel','duel',$3,'hold',$4,'Stake captured (duel)', $5)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [h.member_id, -Number(h.amount_held), duel_id, h.hold_id, idemKey({k:'stake_captured_duel', duel_id, hold:h.hold_id})]);
    await Promise.all([stakeCap(A), stakeCap(B)]);

    const pot   = Number(A.amount_held) + Number(B.amount_held);
    const payout= Math.floor(pot * (1 - DEFAULT_HOUSE_RATE));
    const rake  = pot - payout;
    const winMember = (String(winner).toUpperCase()==='A') ? A.member_id : B.member_id;

    await cli.query(`
      INSERT INTO ff_points_ledger (member_id, currency, delta_points, kind, source, source_id, memo, idempotency_key)
      VALUES ($1,'points',$2,'duel_payout','duel',$3,'Winner payout', $4)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [winMember, payout, duel_id, idemKey({k:'duel_payout', duel_id, win:winMember, payout})]);

    await cli.query(`
      INSERT INTO ff_points_ledger (member_id, currency, delta_points, kind, source, source_id, memo, idempotency_key)
      VALUES ($1,'points',$2,'rake','duel',$3,'House rake', $4)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [HOUSE_ID, rake, duel_id, idemKey({k:'duel_rake', duel_id, rake})]);

    await cli.query(`UPDATE ff_duel SET status='closed', updated_at=NOW() WHERE id=$1`, [duel_id]);

    await cli.query('COMMIT');
    res.json({ ok:true, pot, payout, rake });
  }catch(e){
    await cli.query('ROLLBACK');
    console.error('duels.settle', e);
    res.status(400).json({ ok:false, error:e.message });
  }finally{ cli.release(); }
});

module.exports = router;
