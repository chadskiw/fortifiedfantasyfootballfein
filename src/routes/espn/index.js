// src/routes/espn/index.js
// ESPN endpoints used by your login/bootstrap flow:
//   GET /api/espn/status
//   GET /api/espn/login
//   GET /api/espn/leagues?season=2025
//
// Notes:
// - Purely cookie/header based (no HTML).
// - Uses global fetch if you choose to call ESPN later;
//   for now, returns an empty-but-normalized leagues array to unblock UI.

const express = require('express');
const router  = express.Router();

// Accept ESPN cookies from either real browser cookies or proxy headers.
// Cookie names used by ESPN: SWID and espn_s2
function readEspnCreds(req) {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || null;
  const s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || null;
  return { swid, s2 };
}

// Minimal status for your service worker/bootstrap
router.get('/status', (req, res) => {
  const { swid, s2 } = readEspnCreds(req);
  const has = !!(swid && s2);
  res.set('Cache-Control','no-store');
  res.json({
    ok: true,
    hasEspnCookies: has,
    swidShort: swid ? String(swid).slice(0,10) + '…' : null
  });
});

// Your login.js expects step:'logged_in' or 'link_needed'
router.get('/login', (req, res) => {
  const { swid, s2 } = readEspnCreds(req);
  const has = !!(swid && s2);
  res.set('Cache-Control','no-store');
  if (has) {
    return res.json({ ok: true, step: 'logged_in' });
  }
  return res.json({ ok: true, step: 'link_needed' });
});

// Normalizer gives you a cross-platform league shape.
// For now this route returns a valid, empty payload to stop 404s and unblock UI.
// Wire real ESPN fetching when ready.
const { normalizeLeague } = require('./normalize');

router.get('/leagues', async (req, res) => {
  const season = parseInt(req.query.season, 10) || new Date().getFullYear();
  // TODO: populate from DB or ESPN. For now, empty list in your global shape.
  const leagues = []; // e.g., [normalizeLeague(rawEspnLeague)]
  res.set('Cache-Control','no-store');
  res.json({ ok: true, season, leagues });
});

module.exports = router;
