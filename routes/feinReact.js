// src/routes/feinReact.js
import express from 'express';
import { tx, one, all } from '../db.js';

const router = express.Router();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://fortifiedfantasy.com';

router.options('/', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.status(204).end();
});

router.post('/', async (req, res) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  try {
    const { entity_key, type, user_id, inc = 1 } = req.body || {};
    const t = String(type || '').toLowerCase();

    if (!entity_key || !user_id || !['fire','fish','trash'].includes(t)) {
      return res.status(400).json({ ok:false, error:'Bad input' });
    }

    await tx(async ({ q, one }) => {
      const isOwnTeam =
        entity_key.startsWith('fflteam:') &&
        !!(await one(
          `SELECT 1 FROM fein_user_teams_with_key WHERE user_id=$1 AND entity_key=$2 LIMIT 1`,
          [user_id, entity_key]
        ));

      if (t === 'fire') {
        if (isOwnTeam) {
          const today = new Date().toISOString().slice(0,10);
          const daily = await one(`
            INSERT INTO fein_fire_daily (entity_key, user_id, day, qty)
            VALUES ($1,$2,$3, LEAST(1,1))
            ON CONFLICT (entity_key, user_id, day)
            DO UPDATE SET qty = LEAST(fein_fire_daily.qty + 1, 1)
            RETURNING qty
          `, [entity_key, user_id, today]);

          if (daily.qty === 1) {
            await q(`
              INSERT INTO fein_reaction_user (entity_key, user_id, type, qty)
              VALUES ($1,$2,'fire',1)
              ON CONFLICT (entity_key, user_id, type)
              DO UPDATE SET qty = fein_reaction_user.qty + 1, updated_at = now()
            `, [entity_key, user_id]);

            await q(`
              INSERT INTO fein_reaction_totals (entity_key, type, total)
              VALUES ($1,'fire',1)
              ON CONFLICT (entity_key, type)
              DO UPDATE SET total = fein_reaction_totals.total + 1
            `, [entity_key]);
          }
        } else {
          const add = Math.max(1, Number(inc) || 1);
          await q(`
            INSERT INTO fein_reaction_user (entity_key, user_id, type, qty)
            VALUES ($1,$2,'fire',$3)
            ON CONFLICT (entity_key, user_id, type)
            DO UPDATE SET qty = fein_reaction_user.qty + EXCLUDED.qty, updated_at = now()
          `, [entity_key, user_id, add]);

          await q(`
            INSERT INTO fein_reaction_totals (entity_key, type, total)
            VALUES ($1,'fire',$2)
            ON CONFLICT (entity_key, type)
            DO UPDATE SET total = fein_reaction_totals.total + EXCLUDED.total
          `, [entity_key, add]);
        }
      } else {
        // fish / trash — toggle 0/1
        const existing = await one(`
          SELECT qty FROM fein_reaction_user
          WHERE entity_key=$1 AND user_id=$2 AND type=$3
        `, [entity_key, user_id, t]);

        if (existing && existing.qty > 0) {
          await q(`
            UPDATE fein_reaction_user
            SET qty=0, updated_at=now()
            WHERE entity_key=$1 AND user_id=$2 AND type=$3
          `, [entity_key, user_id, t]);

          await q(`
            UPDATE fein_reaction_totals
            SET total = GREATEST(total - 1, 0)
            WHERE entity_key=$1 AND type=$2
          `, [entity_key, t]);
        } else {
          await q(`
            INSERT INTO fein_reaction_user (entity_key, user_id, type, qty)
            VALUES ($1,$2,$3,1)
            ON CONFLICT (entity_key, user_id, type)
            DO UPDATE SET qty=1, updated_at=now()
          `, [entity_key, user_id, t]);

          await q(`
            INSERT INTO fein_reaction_totals (entity_key, type, total)
            VALUES ($1,$2,1)
            ON CONFLICT (entity_key, type)
            DO UPDATE SET total = fein_reaction_totals.total + 1
          `, [entity_key, t]);
        }
      }
    });

    const totalsRows = await all(
      `SELECT type, total FROM fein_reaction_totals WHERE entity_key=$1`,
      [entity_key]
    );
    const totals = { fire:0, fish:0, trash:0 };
    for (const r of totalsRows) totals[r.type] = Number(r.total||0);

    res.json({ ok:true, entity_key, type:t, totals });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:e.message || String(e) });
  }
});

export default router;
