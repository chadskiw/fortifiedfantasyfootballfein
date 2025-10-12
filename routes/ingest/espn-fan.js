// routes/ingest/espn-fan.js
const express = require('express');
const router  = express.Router();
// routes/ingest/espn-fan.js

function absoluteUrl(req, path) {
  if (/^https?:\/\//i.test(path)) return path;
  const origin =
    process.env.PUBLIC_ORIGIN
    || (req.protocol && req.get('host') ? `${req.protocol}://${req.get('host')}` : 'https://fortifiedfantasy.com');
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

async function espnGet(req, path, qs = {}) {
  const url = new URL(absoluteUrl(req, '/api/platforms/espn/' + path.replace(/^\/+/, '')));
  Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), { headers:{ 'x-espn-swid': req.headers['x-espn-swid'], 'x-espn-s2': req.headers['x-espn-s2'] } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

router.post('/season', async (req, res) => {
  const pool   = req.app.get('pg');
  const season = Number(req.body?.season || req.query?.season || new Date().getUTCFullYear());
  if (!Number.isFinite(season)) return res.status(400).json({ ok:false, error:'season required' });

  try {
    const poll = await espnGet(req, 'poll', { season });
    // ...rest unchanged...
    res.json({ ok:true, season, leaguesCount: (poll?.leagues||[]).length });
  } catch (e) {
    console.error('[ingest/fan]', e);
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});


module.exports = router;
