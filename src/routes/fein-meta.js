// TRUE_LOCATION: src/routes/fein-meta.js
// IN_USE: FALSE
// routes/fein-meta.js
// Mount at: app.use('/api/fein', require('./routes/fein-meta'));
const express = require('express');
const router = express.Router();
const { upsertFeinMeta } = require('../src/db/feinMeta');

// Tiny cookie parser (avoid extra deps)
function readCookies(header = '') {
  const out = {};
  (header || '').split(/;\s*/).forEach(p => {
    if (!p) return;
    const i = p.indexOf('=');
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? '' : decodeURIComponent(p.slice(i + 1));
    out[k] = v;
  });
  return out;
}

router.get('/__alive', (_req, res) =>
  res.json({ ok: true, scope: '/api/fein' })
);

/**
 * POST /api/fein/meta/upsert
 * Body: { season, platform, league_id, team_id, swid?, s2? }
 * Also accepts:
 *   - Headers: x-espn-swid, x-espn-s2
 *   - Cookies: SWID, espn_s2
 */
router.post('/meta/upsert', async (req, res) => {
  try {
    const season    = Number(req.body?.season);
    const platform  = String(req.body?.platform || '').toLowerCase();
    const league_id = String(req.body?.league_id || '').trim();
    const team_id   = String(req.body?.team_id || '').trim();

    const cookieJar = readCookies(req.headers.cookie || '');
    const swid =
      (req.headers['x-espn-swid'] || req.body?.swid || cookieJar.SWID || '').trim();
    const s2 =
      (req.headers['x-espn-s2']   || req.body?.s2   || cookieJar.espn_s2 || '').trim();

    if (!season || !platform || !league_id || !team_id) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    if (platform !== 'espn') {
      return res.status(400).json({ ok: false, error: 'platform must be "espn"' });
    }
    if (!swid || !s2) {
      return res.status(400).json({ ok: false, error: 'Missing swid/s2 credentials' });
    }

    const row = await upsertFeinMeta({
      season,
      platform: 'espn',
      league_id,
      team_id,
      name: null,
      handle: null,
      league_size: null,
      fb_groups: null,
      swid,
      espn_s2: s2,
    });

    return res.status(200).json({ ok: true, row });
  } catch (err) {
    console.error('[fein-meta] upsert error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
