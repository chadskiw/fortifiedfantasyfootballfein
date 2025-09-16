// server/routes/fein-meta.js
const express = require('express');
const router = express.Router();
const { upsertFeinMeta, getFeinMetaByKey } = require('../src/db/feinMeta');

// Parse both JSON and form
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

/**
 * POST /api/fein-auth/fein/meta/upsert
 * Accepts: season, platform ('espn'), league_id, team_id, name?, handle?, league_size?, fb_groups?
 * Reads SWID / espn_s2 from cookies (HttpOnly on your domain)
 */
router.post('/fein/meta/upsert', async (req, res) => {
  try {
    const {
      season,
      platform = 'espn',
      league_id,
      team_id,
      name = null,
      handle = null,
      league_size = null,
      fb_groups = null,
    } = req.body || {};

    if (!season || !league_id || !team_id) {
      return res.status(400).json({ ok: false, error: 'missing season/league_id/team_id' });
    }

    // Pull ESPN cookies set by your auth flow (HttpOnly on fortifiedfantasy.com)
    const swid   = req.cookies?.SWID     || null;
    const espn_s2 = req.cookies?.espn_s2 || req.cookies?.ESPN_S2 || null;

    const row = await upsertFeinMeta({
      season: Number(season),
      platform,
      league_id,
      team_id,
      name,
      handle,
      league_size: league_size != null ? Number(league_size) : null,
      fb_groups,
      swid,
      espn_s2,
    });

    return res.status(200).json({ ok: true, meta: row });
  } catch (e) {
    console.error('[fein-meta upsert] error:', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** Optional GET for debugging */
router.get('/fein/meta', async (req, res) => {
  try {
    const { season, platform = 'espn', league_id, team_id } = req.query || {};
    if (!season || !league_id || !team_id) {
      return res.status(400).json({ ok:false, error:'missing season/league_id/team_id' });
    }
    const row = await getFeinMetaByKey({ season: Number(season), platform, league_id, team_id });
    return res.json({ ok:true, meta: row });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

module.exports = router;
