// routes/platforms/espn/link.js
const express = require('express');
const router  = express.Router();

function decodePlus(s){ try{ return decodeURIComponent(String(s||'').replace(/\+/g,'%20')); } catch { return String(s||''); } }
function normalizeSwid(raw){
  let v = decodePlus(raw||'').trim(); if (!v) return '';
  v = v.replace(/^%7B/i,'{').replace(/%7D$/i,'}');
  if (!v.startsWith('{')) v = `{${v.replace(/^\{?/, '').replace(/\}?$/, '')}}`;
  return v.toUpperCase();
}

router.get('/api/espn/link', async (req, res) => {
  const { swid, s2, to, season } = req.query;
  if (!swid || !s2) return res.status(400).send('swid and s2 required');

  // set short/medium TTL cookies
  res.cookie('espn_swid', swid, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 7*24*3600e3 });
  res.cookie('espn_s2',   s2,   { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 7*24*3600e3 });

  // fire-and-forget ingest with headers (so it works even before FE requests arrive)
  const origin = absoluteOrigin(req);
  const body = JSON.stringify({ season: Number(season) || new Date().getUTCFullYear() });
  fetch(`${origin}/api/ingest/espn/fan/season`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-espn-swid': swid,
      'x-espn-s2': s2
    },
    body
  }).catch(()=>{}); // don’t block redirect

  res.redirect(to || `${origin}/fein/?season=${encodeURIComponent(season||'')}`);
});


module.exports = router;
