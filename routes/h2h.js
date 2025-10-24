// routes/h2h.js
const router = require('express').Router();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const HOUSE_ID = process.env.FF_HOUSE_MEMBER || 'HOUSE';
const DEFAULT_HOUSE_RATE = Number(process.env.FF_H2H_HOUSE_RATE || 0.045);

// --- utils ---
function sideToNum(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (t === '1' || t === 'home' || t === 'left' || t === 'a') return 1;
  if (t === '2' || t === 'away' || t === 'right' || t === 'b') return 2;
  return null;
}
function sideTokens(n) {
  return n === 1 ? ['1','home','left','a'] :
         n === 2 ? ['2','away','right','b'] : [];
}

function idemKey(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 40);
}

// identity helper (server-side, relative to current route)
async function getMemberId(req) {
  const proto  = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host   = req.headers['x-forwarded-host']  || req.headers.host;
  const origin = process.env.INTERNAL_ORIGIN || `${proto}://${host}`;
  const base   = new URL(req.originalUrl || '/', origin);
  const idUrl  = new URL('../identity/me', base);
  const r = await fetch(idUrl, { headers: { cookie: req.headers.cookie || '' }});
  if (!r.ok) throw new Error('not_authenticated');
  const me = await r.json();
  const id = me.member_id || me.memberId || me.identity?.member_id || me.identity?.memberId;
  if (!id) throw new Error('not_authenticated');
  return String(id);
}

async function withTx(fn) {
  const cli = await pool.connect();
  try { await cli.query('BEGIN'); const out = await fn(cli); await cli.query('COMMIT'); return out; }
  catch (e) { await cli.query('ROLLBACK'); throw e; }
  finally { cli.release(); }
}

async function availablePoints(cli, memberId) {
  const { rows: [w] } = await cli.query(`
    WITH bal AS ( SELECT COALESCE(SUM(delta_points),0) AS pts FROM ff_points_ledger WHERE member_id=$1 ),
         held AS ( SELECT COALESCE(SUM(amount_held),0)   AS held FROM ff_holds         WHERE member_id=$1 AND status='held' )
    SELECT (bal.pts - held.held) AS available FROM bal, held
  `, [memberId]);
  return Number(w?.available || 0);
}

/* ===========================
   LIST OPEN/PENDING (Mini Hub)
   GET /api/h2h/open?teams=lid:tid,lid:tid or ?me=1
   =========================== */
router.get('/open', async (req, res) => {
  try {
    const teamsCsv = String(req.query.teams || '').trim();
    const teams = teamsCsv ? teamsCsv.split(',').map(x => x.trim()).filter(Boolean) : [];
    const wantMine = req.query.me === '1';

    const where = [`c.status IN ('open','pending')`];
    const params = [];

    if (teams.length) where.push(`(s.league_id || ':' || s.team_id) = ANY($${params.push(teams)}::text[])`);

    if (wantMine) {
      // use identity, not cookie
      let meId = null;
      try { meId = await getMemberId(req); } catch {}
      if (!meId) return res.json({ ok: true, items: [] });
      where.push(`(s.owner_member_id = $${params.push(meId)} OR s.claimed_by_member_id = $${params.push(meId)})`);
    }

    const sql = `
      SELECT c.id, c.season, c.week, c.status, c.stake_points, c.updated_at,
             jsonb_agg(jsonb_build_object(
               'side', s.side, 'league_id', s.league_id, 'team_id', s.team_id,
               'team_name', s.team_name, 'locked_at', s.locked_at, 'points_final', s.points_final
             ) ORDER BY s.side) AS sides
      FROM ff_challenge c
      JOIN ff_challenge_side s ON s.challenge_id = c.id
      WHERE ${where.join(' AND ')}
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT 50`;
    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error('h2h.open.error', e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

/* ===========================
   CLAIM A SIDE
   POST /api/h2h/claim
   body: { ch_id, side: 1|2|'home'|'away', roster_json? }
   =========================== */
router.post('/claim', async (req, res) => {
  try {
    const memberId = await getMemberId(req);
    const { ch_id, side, roster_json } = req.body || {};
    const sideNum = sideToNum(side);
    if (!ch_id || !sideNum) return res.status(400).json({ ok:false, error:'missing_args' });

    const out = await withTx(async (cli) => {
      const { rows: sides } = await cli.query(
   `SELECT side, league_id, team_id, team_name, claimed_by_member_id, hold_id, locked_at, roster_json
      FROM ff_challenge_side
     WHERE challenge_id=$1
     FOR UPDATE`, [ch_id]);
 const meSide = sides.find(s => sideToNum(s.side) === sideNum);
 const other  = sides.find(s => sideToNum(s.side) !== sideNum);
      if (!meSide) throw new Error('side_not_found');
      if (meSide.claimed_by_member_id) throw new Error('side_already_claimed');

      const stake = Number(ch.stake_points || 0);
      if (stake <= 0) throw new Error('invalid_stake');

      const avail = await availablePoints(cli, memberId);
      if (avail < stake) throw new Error('insufficient_funds');

      const memo   = `h2h:${ch_id}:${sideNum === 1 ? 'home' : 'away'}`;
      const holdId = crypto.randomUUID();
      await cli.query(
        `INSERT INTO ff_holds (hold_id, member_id, amount_held, status, memo, created_at, updated_at)
         VALUES ($1,$2,$3,'held',$4,NOW(),NOW())`,
        [holdId, memberId, stake, memo]
      );

      const rosterSeed = (meSide.roster_json || roster_json) || { starters: [], bench: [] };
      await cli.query(
        `UPDATE ff_challenge_side
            SET claimed_by_member_id=$1, claimed_at=NOW(), hold_id=$2, roster_json=$3, updated_at=NOW()
     WHERE challenge_id=$4
       AND lower(side::text) = ANY($5::text[])
`, [memberId, holdId, rosterSeed, ch_id, sideTokens(sideNum)]);

      const isSecond = !!other?.claimed_by_member_id;
      if (isSecond) {
        await cli.query(`UPDATE ff_challenge SET status='locked', updated_at=NOW() WHERE id=$1`, [ch_id]);
        await cli.query(`UPDATE ff_challenge_side SET locked_at=NOW(), updated_at=NOW() WHERE challenge_id=$1`, [ch_id]);
      } else if (ch.status === 'open') {
        await cli.query(`UPDATE ff_challenge SET status='pending', updated_at=NOW() WHERE id=$1`, [ch_id]);
      }

      const newAvail = await availablePoints(cli, memberId);
      return { status: isSecond ? 'locked' : 'pending', hold_id: holdId, available_points: newAvail, side: sideNum };
    });

    res.json({ ok:true, ...out });
  } catch (e) {
    console.error('h2h.claim.error', e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

/* ===========================
   SWAP LINEUP (bench <-> starter)
   POST /api/h2h/lineup/swap
   body: { ch_id, side, promote_pid, demote_pid }
   =========================== */
router.post('/lineup/swap', async (req, res) => {
  try {
    const memberId = await getMemberId(req);
    const { ch_id, side, promote_pid, demote_pid } = req.body || {};
    const sideNum = sideToNum(side);

    if (!ch_id || !sideNum || !promote_pid || !demote_pid) {
      return res.status(400).json({ ok:false, error:'missing_args' });
    }
    if (String(promote_pid) === String(demote_pid)) {
      return res.status(400).json({ ok:false, error:'same_player' });
    }

    const out = await withTx(async (cli) => {
      const { rows: [ch] } = await cli.query(
        `SELECT id, status FROM ff_challenge WHERE id=$1 FOR UPDATE`, [ch_id]
      );
      if (!ch) throw new Error('challenge_not_found');
      if (ch.status === 'locked') throw new Error('challenge_locked');

       const { rows: [s] } = await cli.query(
   `SELECT roster_json, claimed_by_member_id
      FROM ff_challenge_side
     WHERE challenge_id=$1
       AND lower(side::text) = ANY($2::text[])
     FOR UPDATE`,
   [ch_id, sideTokens(sideNum)]
 );
      if (!s) throw new Error('side_not_found');
      if (String(s.claimed_by_member_id) !== String(memberId)) throw new Error('not_your_side');

      const r = s.roster_json || { starters: [], bench: [] };
      const starters = Array.isArray(r.starters) ? [...r.starters] : [];
      const bench    = Array.isArray(r.bench)    ? [...r.bench]    : [];

      const bIdx = bench.findIndex(p => String(p.pid) === String(promote_pid));
      const sIdx = starters.findIndex(p => String(p.pid) === String(demote_pid));
      if (bIdx === -1 || sIdx === -1) throw new Error('players_not_found');

      const benchPlayer   = bench[bIdx];
      const starterPlayer = starters[sIdx];
      starters[sIdx] = benchPlayer;
      bench[bIdx]    = starterPlayer;

      const newRoster = { starters, bench };
      await cli.query(
        `UPDATE ff_challenge_side
            SET roster_json=$1, updated_at=NOW()
     WHERE challenge_id=$2
       AND lower(side::text) = ANY($3::text[])`,
   [newRoster, ch_id, sideTokens(sideNum)]
      );

      return { roster_json: newRoster };
    });

    res.json({ ok:true, ...out });
  } catch (e) {
    console.error('h2h.swap.error', e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

/* ===========================
   MY LIVE H2Hs (pending + locked)
   GET /api/h2h/my?states=pending,locked
   =========================== */
router.get('/my', async (req, res) => {
  try {
    const memberId = await getMemberId(req);
    const states = String(req.query.states||'pending,locked').split(',').map(s=>s.trim());
    const { rows } = await pool.query(`
      SELECT c.id, c.season, c.week, c.status, c.stake_points, c.updated_at,
             jsonb_agg(jsonb_build_object(
               'side', s.side, 'league_id', s.league_id, 'team_id', s.team_id,
               'team_name', s.team_name, 'claimed_by_member_id', s.claimed_by_member_id,
               'locked_at', s.locked_at
             ) ORDER BY s.side) AS sides
      FROM ff_challenge c
      JOIN ff_challenge_side s ON s.challenge_id = c.id
      WHERE c.status = ANY($1::text[])
        AND EXISTS (
          SELECT 1 FROM ff_challenge_side sx
           WHERE sx.challenge_id=c.id
             AND (sx.owner_member_id=$2 OR sx.claimed_by_member_id=$2)
        )
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT 100
    `, [states, memberId]);
    res.json({ ok:true, items: rows });
  } catch (e) {
    console.error('h2h.my.error', e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

/* ===========================
   SETTLE (unchanged)
   POST /api/h2h/settle
   =========================== */
router.post('/settle', async (req, res) => {
  const { ch_id, winner, house_rate } = req.body || {};
  if (!ch_id || !['home','away'].includes(winner)) {
    return res.status(400).json({ ok:false, error:'missing_args' });
  }
  const houseRate = Math.max(0, Math.min(0.5, Number(house_rate ?? DEFAULT_HOUSE_RATE)));

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const { rows: holds } = await cli.query(
      `SELECT * FROM ff_holds WHERE status='held' AND memo IN ($1,$2) FOR UPDATE`,
      [`h2h:${ch_id}:home`, `h2h:${ch_id}:away`]
    );
    if (holds.length < 1) throw new Error('holds_not_found');
    const home = holds.find(h => h.memo.endsWith(':home'));
    const away = holds.find(h => h.memo.endsWith(':away'));
    if (!home || !away) throw new Error('both_sides_required');

    await cli.query(
      `UPDATE ff_holds SET status='captured', amount_captured=amount_held, captured_at=NOW(), updated_at=NOW()
       WHERE hold_id = ANY($1::text[])`,
      [[home.hold_id, away.hold_id]]
    );

    const mkStakeRow = (h) => cli.query(`
      INSERT INTO ff_points_ledger (member_id, currency, delta_points, kind, source, source_id, ref_type, ref_id, memo, idempotency_key)
      VALUES ($1,'points',$2,'stake_captured_h2h','h2h',$3,'hold',$4,'Stake captured', $5)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [h.member_id, -Number(h.amount_held), ch_id, h.hold_id, idemKey({k:'stake_captured_h2h', ch_id, hold:h.hold_id})]);

    await Promise.all([mkStakeRow(home), mkStakeRow(away)]);

    const pot = Number(home.amount_held) + Number(away.amount_held);
    const payout = Math.floor(pot * (1 - houseRate));
    const rake   = pot - payout;
    const winnerMember = (winner === 'home') ? home.member_id : away.member_id;

    await cli.query(`
      INSERT INTO ff_points_ledger (member_id, currency, delta_points, kind, source, source_id, memo, idempotency_key)
      VALUES ($1,'points',$2,'h2h_payout','h2h',$3,'Winner payout', $4)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [winnerMember, payout, ch_id, idemKey({k:'h2h_payout', ch_id, winner: winnerMember, payout})]);

    await cli.query(`
      INSERT INTO ff_points_ledger (member_id, currency, delta_points, kind, source, source_id, memo, idempotency_key)
      VALUES ($1,'points',$2,'rake','h2h',$3,'House rake', $4)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [HOUSE_ID, rake, ch_id, idemKey({k:'h2h_rake', ch_id, rake})]);

    await cli.query('COMMIT');
    return res.json({ ok:true, pot, payout, rake });
  } catch (e) {
    await cli.query('ROLLBACK');
    console.error('h2h.settle.error', e);
    return res.status(400).json({ ok:false, error:e.message });
  } finally {
    cli.release();
  }
});

module.exports = router;
