// routes/h2h.js  (new tables: ff_wallet, ff_hold, ff_ledger)
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
function toInt(x){
  const s = String(x ?? '').replace(/[^\d-]/g, '');
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function idemKey(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 40);
}
async function fetchEspnRoster(req, season, week, leagueId, teamId) {
  const proto  = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host   = req.headers['x-forwarded-host']  || req.headers.host;
  const origin = `${proto}://${host}`;
  const url    = `${origin}/api/platforms/espn/roster?season=${season}&week=${week}&leagueId=${leagueId}&teamId=${teamId}`;

  const r = await fetch(url, { headers: { cookie: req.headers.cookie || '' } });
  if (!r.ok) return null;

  const j = await r.json();
  const items = (j.players || j.roster || []);
  const starters = items.filter(p => p.isStarter ?? (p.lineupSlotId !== undefined ? p.lineupSlotId < 20 : true));
  const bench    = items.filter(p => p.isStarter === false || (p.lineupSlotId !== undefined && p.lineupSlotId >= 20));
  return { starters, bench };
}

// identity helper (server-side)
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

// === wallet helpers (new tables) ===

// ensure PLAY/POINT wallet and return wallet_id
async function ensureWalletId(cli, memberId) {
  await cli.query(
    `INSERT INTO ff_wallet(member_id, kind, currency)
     VALUES ($1,'PLAY','POINT')
     ON CONFLICT (member_id, kind, currency) DO NOTHING`,
    [memberId]
  );
  const { rows:[w] } = await cli.query(
    `SELECT wallet_id FROM ff_wallet
      WHERE member_id=$1 AND kind='PLAY' AND currency='POINT' LIMIT 1`,
    [memberId]
  );
  return Number(w?.wallet_id);
}

// available = posted - active holds
async function availablePoints(cli, memberId) {
  // use function if present
  try {
    const { rows:[r] } = await cli.query(
      `SELECT wallet_id, posted_balance, locked_amount
         FROM ff_get_wallet_balances($1)
        WHERE kind='PLAY' AND currency='POINT'
        LIMIT 1`, [memberId]
    );
    if (r) return Number(r.posted_balance) - Number(r.locked_amount);
  } catch (_e) { /* fall back */ }

  const wid = await ensureWalletId(cli, memberId);
  const { rows:[p] } = await cli.query(
    `SELECT COALESCE(SUM(amount),0) AS n
       FROM ff_ledger WHERE wallet_id=$1 AND status='posted'`, [wid]
  );
  const { rows:[l] } = await cli.query(
    `SELECT COALESCE(SUM(amount),0) AS n
       FROM ff_hold   WHERE wallet_id=$1 AND status='active'`, [wid]
  );
  return Number(p?.n || 0) - Number(l?.n || 0);
}

// create (or reuse) an active hold for stake
async function createOrGetHold(cli, memberId, stakePoints, refId) {
  const wid = await ensureWalletId(cli, memberId);

  // idempotency: reuse existing active hold for same (wallet, 'h2h', refId)
  const { rows:[h0] } = await cli.query(
    `SELECT hold_id FROM ff_hold
      WHERE wallet_id=$1 AND status='active' AND ref_type='h2h' AND ref_id=$2
      LIMIT 1`,
    [wid, refId]
  );
  if (h0) return Number(h0.hold_id);

  const { rows:[h] } = await cli.query(
    `INSERT INTO ff_hold (wallet_id, amount, currency, reason, ref_type, ref_id, status, meta)
     VALUES ($1, $2, 'POINT', 'h2h', 'h2h', $3, 'active', jsonb_build_object('created_by','h2h.claim'))
     RETURNING hold_id`,
    [wid, stakePoints, refId]
  );
  return Number(h.hold_id);
}

// fetch wallet_id for a hold
async function walletIdForHold(cli, holdId) {
  const { rows:[h] } = await cli.query(`SELECT wallet_id, amount FROM ff_hold WHERE hold_id=$1`, [holdId]);
  if (!h) throw new Error('hold_not_found');
  return { walletId: Number(h.wallet_id), amount: Number(h.amount) };
}
// --- DETAIL (single challenge) ---
// GET /api/h2h/detail?chId=...   or   /api/h2h/detail/:id
router.get(['/detail', '/detail/:id'], async (req, res) => {
  try {
    const chId = req.params.id || req.query.chId || req.query.id;
    if (!chId) return res.status(400).json({ ok:false, error:'missing_ch_id' });

    const { rows:[c] } = await pool.query(
      `SELECT id, season, week, status, stake_points, created_at, updated_at
         FROM ff_challenge WHERE id=$1`,
      [chId]
    );
    if (!c) return res.status(404).json({ ok:false, error:'challenge_not_found' });

    const { rows: sides } = await pool.query(
      `SELECT side, league_id, team_id, team_name,
              claimed_by_member_id, owner_member_id, hold_id,
              locked_at, points_final, roster_json, roster_locked_json
         FROM ff_challenge_side
        WHERE challenge_id=$1
        ORDER BY side`,
      [chId]
    );

    const sideToNum = (s) => {
      const t = String(s ?? '').trim().toLowerCase();
      if (t === '1' || t === 'home' || t === 'left' || t === 'a') return 1;
      if (t === '2' || t === 'away' || t === 'right' || t === 'b') return 2;
      return null;
    };
    const numToSide = (n) => (n === 1 ? 'home' : n === 2 ? 'away' : null);
    const toInt = (x) => {
      const s = String(x ?? '').replace(/[^\d-]/g, '');
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    };

    const shaped = {
      id: c.id,
      season: c.season,
      week: c.week,
      status: c.status,
      stake_points: toInt(c.stake_points),
      created_at: c.created_at,
      updated_at: c.updated_at
    };

    for (const s of sides) {
      const label = numToSide(sideToNum(s.side)) || String(s.side || '').toLowerCase();
      const team = {
        side: label,
        leagueId: toInt(s.league_id),
        teamId: toInt(s.team_id),

        // legacy aliases used by some FE code
        lid: toInt(s.league_id),
        tid: toInt(s.team_id),

        tname: s.team_name || `Team ${s.team_id}`,
        lname: s.league_name || null,  // optional cols in DB; null is fine
        logo:  s.team_logo || null,

        owner_member_id: s.owner_member_id || null,
        claimed_by_member_id: s.claimed_by_member_id || null,
        hold_id: s.hold_id || null,
        locked_at: s.locked_at || null,
        points_final: s.points_final || null,

        // rosters if present; FE can still fetch live from ESPN when null
        roster: s.roster_json || null,
        roster_locked: s.roster_locked_json || null
      };
      if (label === 'home') shaped.home = team;
      else if (label === 'away') shaped.away = team;
      else shaped[label || 'side'] = team;
    }

    res.json({ ok: true, challenge: shaped });
  } catch (e) {
    console.error('h2h.detail.error', e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

// --- ENSURE (create or reuse a challenge) ---
// POST /api/h2h/ensure
// Body: {
//   season, week,
//   left:  { leagueId, teamId, teamName? },
//   right: { leagueId, teamId, teamName? } | null
// }
router.post('/ensure', async (req, res) => {
  try {
    const { season, week, left, right } = req.body || {};
    const S = Number(season)||new Date().getFullYear();
    const W = Number(week)||1;

    const norm = (x) => !x ? null : ({
      leagueId: Number(x.leagueId||x.lid||x.league_id)||null,
      teamId:   Number(x.teamId||x.tid||x.team_id)||null,
      teamName: x.teamName || x.tname || null
    });

    const L = norm(left);
    const R = norm(right);
    if (!L || !L.leagueId || !L.teamId) {
      return res.status(400).json({ ok:false, error:'missing_left' });
    }

    // helper: same-origin absolute URL for server-side fetch (preserves cookies)
    const origin = `${req.headers['x-forwarded-proto']||req.protocol}`; //${req.headers['x-forwarded-host']||req.headers.host}`;
    const espnRoster = async (lid, tid) => {
      const u = new URL(`/api/platforms/espn/roster?season=${S}&week=${W}&leagueId=${lid}&teamId=${tid}`, origin);
      const r = await fetch(u, { headers: { cookie: req.headers.cookie||'' } });
      if (!r.ok) return null;
      const j = await r.json();
      const items = (j.players || j.roster || []);
      // normalize to { starters[], bench[] } by lineupSlotId (<20 == starter)
      const starters = items.filter(p => p.isStarter ?? (p.lineupSlotId !== undefined ? p.lineupSlotId < 20 : true));
      const bench    = items.filter(p => p.isStarter === false || (p.lineupSlotId !== undefined && p.lineupSlotId >= 20));
      return { starters, bench };
    };

    // 1) Reuse existing challenge if both sides provided
    if (R && R.leagueId && R.teamId) {
      const sql = `
        SELECT c.id
          FROM ff_challenge c
          JOIN ff_challenge_side s1 ON s1.challenge_id=c.id
          JOIN ff_challenge_side s2 ON s2.challenge_id=c.id
         WHERE c.season=$1 AND c.week=$2
           AND (s1.side IN ('home','left','1') AND s1.league_id=$3 AND s1.team_id=$4)
           AND (s2.side IN ('away','right','2') AND s2.league_id=$5 AND s2.team_id=$6)
         LIMIT 1`;
      const { rows:[hit] } = await pool.query(sql, [S,W, L.leagueId,L.teamId, R.leagueId,R.teamId]);
      if (hit) return res.json({ ok:true, id: hit.id });
    } else {
      // open challenge with only left side
      const sql = `
        SELECT c.id
          FROM ff_challenge c
          JOIN ff_challenge_side s1 ON s1.challenge_id=c.id
         WHERE c.season=$1 AND c.week=$2
           AND s1.side IN ('home','left','1')
           AND s1.league_id=$3 AND s1.team_id=$4
           AND NOT EXISTS (
             SELECT 1 FROM ff_challenge_side s2
              WHERE s2.challenge_id=c.id AND s2.side IN ('away','right','2')
           )
         LIMIT 1`;
      const { rows:[hit] } = await pool.query(sql, [S,W, L.leagueId,L.teamId]);
      if (hit) return res.json({ ok:true, id: hit.id });
    }

    // 2) Create new challenge + sides (with roster snapshots for UX)
    const newId = `ch_${crypto.randomBytes(8).toString('hex')}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO ff_challenge (id, season, week, status, stake_points, created_at, updated_at)
         VALUES ($1,$2,$3,'open',0,NOW(),NOW())`,
        [newId, S, W]
      );

      // home / left
      const Lroster = await espnRoster(L.leagueId, L.teamId).catch(()=>null);
      await client.query(
        `INSERT INTO ff_challenge_side
           (challenge_id, side, league_id, team_id, team_name, roster_json, updated_at)
         VALUES ($1,'home',$2,$3,$4,$5,NOW())`,
        [newId, L.leagueId, L.teamId, L.teamName, Lroster]
      );

      // away / right (optional)
      if (R && R.leagueId && R.teamId) {
        const Rroster = await espnRoster(R.leagueId, R.teamId).catch(()=>null);
        await client.query(
          `INSERT INTO ff_challenge_side
             (challenge_id, side, league_id, team_id, team_name, roster_json, updated_at)
           VALUES ($1,'away',$2,$3,$4,$5,NOW())`,
          [newId, R.leagueId, R.teamId, R.teamName, Rroster]
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return res.json({ ok:true, id:newId });
  } catch (e) {
    console.error('h2h.ensure.error', e);
    res.status(400).json({ ok:false, error:e.message });
  }
});


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
      let meId = null; try { meId = await getMemberId(req); } catch {}
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
   body: { ch_id, side: 1|2|'home'|'away', roster_json?, stake_points? }
   =========================== */
router.post('/claim', async (req, res) => {
  try {
    const memberId = await getMemberId(req);
    const { ch_id, side, roster_json, stake_points } = req.body || {};
    const sideNum = sideToNum(side);
    if (!ch_id || !sideNum) return res.status(400).json({ ok:false, error:'missing_args' });

    const out = await withTx(async (cli) => {
      // 1) lock challenge
      const { rows:[ch] } = await cli.query(
        `SELECT id, status, stake_points, season, week
           FROM ff_challenge WHERE id=$1 FOR UPDATE`, [ch_id]
      );
      if (!ch) throw new Error('challenge_not_found');
      if (!['open','pending'].includes(ch.status)) throw new Error('challenge_not_open');

      // allow body to seed stake if DB has 0
      let stake = toInt(ch.stake_points);
      const bodyStake = toInt(stake_points);
      if (stake <= 0 && bodyStake > 0) {
        stake = bodyStake;
        await cli.query(`UPDATE ff_challenge SET stake_points=$2, updated_at=NOW() WHERE id=$1`, [ch_id, stake]);
      }
      if (stake <= 0) throw new Error('invalid_stake');

      // 2) lock sides
      const { rows: sides } = await cli.query(
        `SELECT side, league_id, team_id, team_name, claimed_by_member_id, hold_id, locked_at, roster_json
           FROM ff_challenge_side
          WHERE challenge_id=$1 FOR UPDATE`, [ch_id]
      );
      const meSide = sides.find(s => sideToNum(s.side) === sideNum);
      const other  = sides.find(s => sideToNum(s.side) !== sideNum);
      if (!meSide) throw new Error('side_not_found');
      if (meSide.claimed_by_member_id) throw new Error('side_already_claimed');

      // 3) funds check + create hold (unchanged)
const avail = await availablePoints(cli, memberId);
if (avail < stake) throw new Error('insufficient_funds');

const refId  = `${ch_id}:${sideNum === 1 ? 'home' : 'away'}`;
const holdId = await createOrGetHold(cli, memberId, stake, refId);

// 4) mark claim + SNAPSHOT now
// Load sides (we already have `sides` from earlier SELECT ... FOR UPDATE)
const me = meSide;    // side user is claiming
const ot = other;     // opponent side (may be undefined if not created yet)

// Prefer DB → body → fresh pull
const bodyRoster = (roster_json && (roster_json.starters || roster_json.bench)) ? roster_json : null;
let myFresh = me.roster_json || bodyRoster;
if (!myFresh) {
  myFresh = await fetchEspnRoster(req, ch.season, ch.week, me.league_id, me.team_id).catch(() => null);
}
if (!myFresh) myFresh = { starters: [], bench: [] };

// Snapshot claimant immediately: set both working + locked copies.
// We do NOT touch locked_at here (leave it for full lock).
await cli.query(
  `UPDATE ff_challenge_side
      SET claimed_by_member_id=$1,
          claimed_at=NOW(),
          hold_id=$2,
          roster_json = COALESCE(roster_json, $3),
          roster_locked_json = COALESCE(roster_locked_json, $3),
          updated_at=NOW()
    WHERE challenge_id=$4
      AND lower(side::text) = ANY($5::text[])`,
  [memberId, holdId, myFresh, ch_id, sideTokens(sideNum)]
);

// Opportunistically cache opponent's live roster if empty (do not lock them)
if (ot && !ot.roster_json) {
  const otherFresh = await fetchEspnRoster(req, ch.season, ch.week, ot.league_id, ot.team_id).catch(() => null);
  if (otherFresh) {
    await cli.query(
      `UPDATE ff_challenge_side
          SET roster_json=$1,
              updated_at=NOW()
        WHERE challenge_id=$2
          AND lower(side::text) = ANY($3::text[])`,
      [otherFresh, ch_id, sideTokens(sideToNum(ot.side))]
    );
  }
}

// 5) advance status (existing logic)
// If second side is already claimed → lock (your current freeze-both block runs)
// Else → pending
const isSecond = !!other?.claimed_by_member_id;

if (isSecond) {
  await cli.query(`UPDATE ff_challenge SET status='locked', updated_at=NOW() WHERE id=$1`, [ch_id]);

  // your existing “freeze both” UPDATE stays as-is
  await cli.query(`
    UPDATE ff_challenge_side
       SET locked_at = NOW(),
           roster_locked_json = CASE
             WHEN roster_json IS NOT NULL
              AND roster_json::text <> '{}'
              AND roster_json ? 'starters'
              AND roster_json ? 'bench'
               THEN roster_json
             ELSE jsonb_build_object(
                    'starters', COALESCE(lineup_json, '[]'::jsonb),
                    'bench',    COALESCE(bench_json,  '[]'::jsonb)
                  )
           END,
           updated_at = NOW()
     WHERE challenge_id = $1
  `, [ch_id]);
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
      const { rows:[ch] } = await cli.query(
        `SELECT id, status FROM ff_challenge WHERE id=$1 FOR UPDATE`, [ch_id]
      );
      if (!ch) throw new Error('challenge_not_found');
      if (ch.status === 'locked') throw new Error('challenge_locked');

      const { rows:[s] } = await cli.query(
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
   SETTLE
   POST /api/h2h/settle
   body: { ch_id, winner: 'home'|'away', house_rate? }
   =========================== */
router.post('/settle', async (req, res) => {
  const { ch_id, winner, house_rate } = req.body || {};
  if (!ch_id || !['home','away'].includes(winner)) {
    return res.status(400).json({ ok:false, error:'missing_args' });
  }
  const houseRate = Math.max(0, Math.min(0.5, Number(house_rate ?? DEFAULT_HOUSE_RATE)));

  await withTx(async (cli) => {
    // Get both sides (for their member ids & hold ids)
    const { rows: sides } = await cli.query(
      `SELECT side, claimed_by_member_id AS member_id, hold_id
         FROM ff_challenge_side
        WHERE challenge_id=$1
        FOR UPDATE`,
      [ch_id]
    );
    if (sides.length !== 2) throw new Error('sides_not_ready');

    const home = sides.find(s => sideToNum(s.side) === 1);
    const away = sides.find(s => sideToNum(s.side) === 2);
    if (!home?.member_id || !away?.member_id) throw new Error('unclaimed_side');

    // Fetch holds (amount + wallet ids)
    const { walletId: homeWid, amount: homeStake } = await walletIdForHold(cli, home.hold_id);
    const { walletId: awayWid, amount: awayStake } = await walletIdForHold(cli, away.hold_id);

    // Validate holds are still active
    const { rows: activeH } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM ff_hold WHERE hold_id = ANY($1::bigint[]) AND status='active'`,
      [[home.hold_id, away.hold_id]]
    );
    if (!activeH[0] || activeH[0].n < 2) throw new Error('holds_not_active');

    const pot   = homeStake + awayStake;
    const rake  = pot - Math.floor(pot * (1 - houseRate));
    const payoutGross = pot - rake;
    const winnerSide  = (winner === 'home') ? home : away;
    const loserSide   = (winner === 'home') ? away : home;
    const winnerWid   = (winner === 'home') ? homeWid : awayWid;
    const loserWid    = (winner === 'home') ? awayWid : homeWid;
    const winnerStake = (winner === 'home') ? homeStake : awayStake;
    const loserStake  = (winner === 'home') ? awayStake : homeStake;

    // Compute "net win" credit (we release winner's hold, so only credit the new value)
    const winnerNetCredit = payoutGross - winnerStake; // >= 0

    // 1) Update holds: loser forfeited, winner released
    await cli.query(
      `UPDATE ff_hold SET status='forfeited', resolved_at=NOW()
         WHERE hold_id=$1 AND status='active'`,
      [loserSide.hold_id]
    );
    await cli.query(
      `UPDATE ff_hold SET status='released', resolved_at=NOW()
         WHERE hold_id=$1 AND status='active'`,
      [winnerSide.hold_id]
    );

    // 2) Ledger postings (idempotent via ff_ledger_ref_uniq)
    //   a) loser stake debit
    await cli.query(
      `INSERT INTO ff_ledger (wallet_id, amount, currency, kind, status, ref_type, ref_id, meta)
       VALUES ($1, $2, 'POINT', 'bet_stake', 'posted', 'h2h', $3, jsonb_build_object('ch_id',$3,'side',$4))
       ON CONFLICT ON CONSTRAINT ff_ledger_ref_uniq DO NOTHING`,
      [loserWid, -loserStake, String(ch_id), String(loserSide.side)]
    );

    //   b) winner net win credit
    if (winnerNetCredit > 0) {
      await cli.query(
        `INSERT INTO ff_ledger (wallet_id, amount, currency, kind, status, ref_type, ref_id, meta)
         VALUES ($1, $2, 'POINT', 'bet_win', 'posted', 'h2h', $3, jsonb_build_object('ch_id',$3,'side',$4,'pot',${pot},'rake',${rake}))
         ON CONFLICT ON CONSTRAINT ff_ledger_ref_uniq DO NOTHING`,
        [winnerWid, winnerNetCredit, String(ch_id), String(winnerSide.side)]
      );
    }

    //   c) house rake credit
    if (rake > 0) {
      const houseWid = await ensureWalletId(cli, HOUSE_ID);
      await cli.query(
        `INSERT INTO ff_ledger (wallet_id, amount, currency, kind, status, ref_type, ref_id, meta)
         VALUES ($1, $2, 'POINT', 'rake', 'posted', 'h2h', $3, jsonb_build_object('ch_id',$3,'rate',$4))
         ON CONFLICT ON CONSTRAINT ff_ledger_ref_uniq DO NOTHING`,
        [houseWid, rake, String(ch_id), houseRate]
      );
    }

    // 3) Mark challenge settled
    await cli.query(
      `UPDATE ff_challenge
          SET status='settled', updated_at=NOW()
        WHERE id=$1`,
      [ch_id]
    );

    // response
    return res.json({
      ok: true,
      ch_id,
      pot,
      payout_gross: payoutGross,
      winner_side: winner,
      rake
    });
  }).catch(e => {
    console.error('h2h.settle.error', e);
    return res.status(400).json({ ok:false, error:e.message });
  });
});

module.exports = router;
