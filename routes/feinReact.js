const express = require('express');
const { tx, one, all } = require('../db');
//const { getRedis } = require('../redis');

const router = express.Router();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://fortifiedfantasy.com';

// ---- tiny helpers -----------------------------------------------------------
function ok(res, data)  { return res.json({ ok: true, ...data }); }
function bad(res, msg)  { return res.status(400).json({ ok: false, error: msg || 'Bad input' }); }
function boom(res, err) { return res.status(500).json({ ok: false, error: err?.message || String(err) }); }
const parseType = (t) => String(t || '').toLowerCase();
const isType = (t) => t === 'fire' || t === 'fish' || t === 'trash';

function totalsObject(rows) {
  const totals = { fire: 0, fish: 0, trash: 0 };
  for (const r of rows) totals[r.type] = Number(r.total || 0);
  return totals;
}
// Redis keys
const rk = {
  total: (entity_key) => `fein:tot:${entity_key}`,          // hash: {fire,fish,trash}
  user:  (u, e, t)     => `fein:user:${u}:${e}:${t}`,       // string: qty (0/1 for fish/trash, N for fire)
  rate:  (u, e, t)     => `fein:rate:${u}:${e}:${t}`,       // simple rate key
  daily: (u, e, day)   => `fein:daily:${u}:${e}:${day}`,    // own-team daily fire
};

// ---- CORS preflight ---------------------------------------------------------
router.options('/', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.status(204).end();
});

// ---- GET totals (handy for UI without mutating) -----------------------------
router.get('/:entity_key', async (req, res) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  try {
    const entity_key = req.params.entity_key;
    if (!entity_key) return bad(res, 'Missing entity_key');

    // Try Redis first
    //const rPromise = getRedis();
    const r = null;
    if (r) {
      const h = await r.hGetAll(rk.total(entity_key));
      if (h && Object.keys(h).length) {
        return ok(res, { entity_key, totals: {
          fire: Number(h.fire || 0),
          fish: Number(h.fish || 0),
          trash: Number(h.trash || 0)
        }});
      }
    }
    // Fallback to DB
    const rows = await all(`SELECT type,total FROM fein_reaction_totals WHERE entity_key=$1`, [entity_key]);
    return ok(res, { entity_key, totals: totalsObject(rows) });
  } catch (e) { return boom(res, e); }
});

// ---- POST react -------------------------------------------------------------
router.post('/', async (req, res) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  try {
    const { entity_key, type, user_id, inc = 1 } = req.body || {};
    const t = parseType(type);
    const u = Number(user_id);

    if (!entity_key || !u || !isType(t)) return bad(res, 'Bad input');

    // ---- rate limit (cheap) -------------------------------------------------
    // Simple token: 10 ops per 5s per (user, entity, type)
    //const rPromise = getRedis();
    const r = null;
    if (r) {
      const rateKey = rk.rate(u, entity_key, t);
      const cur = await r.incr(rateKey);
      if (cur === 1) await r.expire(rateKey, 5);
      if (cur > 10) return bad(res, 'Too many reactions; slow down');
    }

    await tx(async ({ q, one }) => {
      // Ownership check for daily fire cap
      const isOwnTeam =
        t === 'fire' &&
        entity_key.startsWith('fflteam:') &&
        !!(await one(
          `SELECT 1 FROM fein_user_teams_with_key WHERE user_id=$1 AND entity_key=$2 LIMIT 1`,
          [u, entity_key]
        ));

      if (t === 'fire') {
        if (isOwnTeam) {
          // daily cap = 1 on own team
          const today = new Date().toISOString().slice(0, 10);
          let allow = true;

          // Redis daily check first (fast path)
          if (r) {
            const set = await r.setNX(rk.daily(u, entity_key, today), '1');
            if (!set) allow = false;
            else await r.expire(rk.daily(u, entity_key, today), 60 * 60 * 24 + 60); // 1 day + buffer
          }

          if (allow) {
            await q(`
              INSERT INTO fein_reaction_user (entity_key, user_id, type, qty)
              VALUES ($1,$2,'fire',1)
              ON CONFLICT (entity_key, user_id, type)
              DO UPDATE SET qty = fein_reaction_user.qty + 1, updated_at = now()
            `, [entity_key, u]);

            await q(`
              INSERT INTO fein_reaction_totals (entity_key, type, total)
              VALUES ($1,'fire',1)
              ON CONFLICT (entity_key, type)
              DO UPDATE SET total = fein_reaction_totals.total + 1
            `, [entity_key]);

            // Cache bump
            if (r) await r.hIncrBy(rk.total(entity_key), 'fire', 1);
          }
          // if not allowed (already used today), do nothing; falls through to totals fetch

        } else {
          const add = Math.max(1, Number(inc) || 1);

          await q(`
            INSERT INTO fein_reaction_user (entity_key, user_id, type, qty)
            VALUES ($1,$2,'fire',$3)
            ON CONFLICT (entity_key, user_id, type)
            DO UPDATE SET qty = fein_reaction_user.qty + EXCLUDED.qty, updated_at = now()
          `, [entity_key, u, add]);

          await q(`
            INSERT INTO fein_reaction_totals (entity_key, type, total)
            VALUES ($1,'fire',$2)
            ON CONFLICT (entity_key, type)
            DO UPDATE SET total = fein_reaction_totals.total + EXCLUDED.total
          `, [entity_key, add]);

          if (r) await r.hIncrBy(rk.total(entity_key), 'fire', add);
        }
      } else {
        // fish / trash — toggle 0/1
        const existing = await one(`
          SELECT qty FROM fein_reaction_user
          WHERE entity_key=$1 AND user_id=$2 AND type=$3
        `, [entity_key, u, t]);

        if (existing && existing.qty > 0) {
          await q(`
            UPDATE fein_reaction_user
            SET qty=0, updated_at=now()
            WHERE entity_key=$1 AND user_id=$2 AND type=$3
          `, [entity_key, u, t]);

          await q(`
            UPDATE fein_reaction_totals
            SET total = GREATEST(total - 1, 0)
            WHERE entity_key=$1 AND type=$2
          `, [entity_key, t]);

          if (r) await r.hIncrBy(rk.total(entity_key), t, -1);
        } else {
          await q(`
            INSERT INTO fein_reaction_user (entity_key, user_id, type, qty)
            VALUES ($1,$2,$3,1)
            ON CONFLICT (entity_key, user_id, type)
            DO UPDATE SET qty=1, updated_at=now()
          `, [entity_key, u, t]);

          await q(`
            INSERT INTO fein_reaction_totals (entity_key, type, total)
            VALUES ($1,$2,1)
            ON CONFLICT (entity_key, type)
            DO UPDATE SET total = fein_reaction_totals.total + 1
          `, [entity_key, t]);

          if (r) await r.hIncrBy(rk.total(entity_key), t, 1);
        }
      }
    });

    // Respond with latest totals (prefer Redis, otherwise DB)
    let totals;
    const rClient = r;
    if (rClient) {
      const h = await rClient.hGetAll(rk.total(entity_key));
      if (h && Object.keys(h).length) {
        totals = {
          fire: Number(h.fire || 0),
          fish: Number(h.fish || 0),
          trash: Number(h.trash || 0)
        };
      }
    }
    if (!totals) {
      const rows = await all(`SELECT type,total FROM fein_reaction_totals WHERE entity_key=$1`, [entity_key]);
      totals = totalsObject(rows);
    }

    return ok(res, { entity_key, type: t, totals });
  } catch (e) { return boom(res, e); }
});

module.exports = router;
