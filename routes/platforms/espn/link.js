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

// routes/espn/link.js (minimal)
router.get('/link', async (req, res) => {
  const { swid = '', s2 = '', season } = req.query;
  // set cookies for browser use (front-end fetches)
  res.cookie('espn_swid', swid, { httpOnly:false, sameSite:'Lax', secure:true, maxAge: 31536000000 });
  res.cookie('espn_s2',   s2,   { httpOnly:false, sameSite:'Lax', secure:true, maxAge: 31536000000 });

  // also trigger server-side ingest *with* creds
  await fetch(`${absoluteOrigin(req)}/api/ingest/espn/fan/season?season=${season||new Date().getUTCFullYear()}`, {
    method: 'POST',
    headers: {
      'x-espn-swid': swid,
      'x-espn-s2'  : s2,
      'accept'     : 'application/json'
    }
  }).catch(()=>{ /* non-fatal */ });

  const to = req.query.to || `${absoluteOrigin(req)}/fein/?season=${season||new Date().getUTCFullYear()}`;
  res.redirect(to);
});



module.exports = router;
