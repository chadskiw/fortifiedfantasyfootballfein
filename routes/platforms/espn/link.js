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

router.get('/link', async (req, res) => {
  const pool = req.app.get('pg');
  const swid = normalizeSwid(req.query.swid || req.query.SWID);
  const s2   = decodePlus(req.query.espn_s2 || req.query.ESPN_S2 || req.query.s2);
  if (!swid || !s2) return res.status(400).json({ ok:false, error:'missing swid/s2' });

  // 1) persist creds
  const memberId = req.session?.member_id || null;
  await pool.query(`
    INSERT INTO ff_espn_cred (member_id, swid, espn_s2, first_seen, last_seen)
    VALUES ($1,$2,$3, now(), now())
    ON CONFLICT (member_id) DO UPDATE
      SET swid=$2, espn_s2=$3, last_seen=now()
  `, [memberId, swid, s2]);

  // 2) kick multi-sport ingest (fire-and-forget)
  const season = Number(req.query.season) || new Date().getUTCFullYear();
  fetch(`${req.protocol}://${req.get('host')}/api/ingest/espn/fan/all-sports`, {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-espn-swid': swid,
      'x-espn-s2': s2
    },
    body: JSON.stringify({ season })
  }).catch(()=>{});

  // 3) redirect (optional)
  const to = req.query.to || `/fein/index.html?season=${season}`;
  res.redirect(to);
});

module.exports = router;
