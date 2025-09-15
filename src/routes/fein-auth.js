// routes/fein-auth.js
// Mount point: /api/fein-auth
const express = require('express');
const router = express.Router();
const { upsertFeinMeta, getFeinMetaByKey } = require('../src/db/feinMeta');

// Health
router.get('/__alive', (_req, res) => res.json({ ok: true, scope: '/api/fein-auth' }));

// Util: normalize possible sources for ESPN creds
function pickCreds(req) {
  const cookies = req.cookies || {};
  const headers = req.headers || {};
  return {
    swid: (headers['x-espn-swid'] || cookies.SWID || req.body?.swid || '').trim(),
    s2:   (headers['x-espn-s2']   || cookies.espn_s2 || req.body?.s2   || '').trim(),
  };
}

/**
 * POST /api/fein-auth/fein/meta/upsert
 * Body: { season, platform, league_id, team_id, swid?, s2? }
 * Also accepts creds via headers (x-espn-swid/x-espn-s2) or cookies (SWID/espn_s2).
 */
router.post('/fein/meta/upsert', async (req, res) => {
  try {
    const season    = Number(req.body?.season);
    const platform  = String(req.body?.platform || '').toLowerCase();
    const league_id = String(req.body?.league_id || '').trim();
    const team_id   = String(req.body?.team_id || '').trim();

    if (!season || !platform || !league_id || !team_id) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    if (platform !== 'espn') {
      return res.status(400).json({ ok: false, error: 'platform must be "espn"' });
    }

    const { swid, s2 } = pickCreds(req);
    if (!swid || !s2) {
      return res.status(400).json({ ok: false, error: 'Missing swid/s2 credentials' });
    }

    const row = await upsertFeinMeta({
      season, platform, league_id, team_id,
      // fill these later when you fetch league objects
      name: null, handle: null, league_size: null, fb_groups: null,
      swid, espn_s2: s2,
    });

    return res.status(200).json({ ok: true, row });
  } catch (err) {
    console.error('[fein-auth] upsert error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * GET /api/fein-auth/fein/meta/row
 * Query: season, platform, leagueId, teamId
 * Returns stored row (for quick verification after upsert).
 */
router.get('/fein/meta/row', async (req, res) => {
  try {
    const season    = Number(req.query.season);
    const platform  = String(req.query.platform || '').toLowerCase();
    const league_id = String(req.query.leagueId || '').trim();
    const team_id   = String(req.query.teamId || '').trim();

    if (!season || !platform || !league_id || !team_id) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    const row = await getFeinMetaByKey({ season, platform, league_id, team_id });
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });

    return res.json({ ok: true, row });
  } catch (err) {
    console.error('[fein-auth] get row error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
