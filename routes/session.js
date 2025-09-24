// src/routes/session.js
// Mounted at /api/session
// POST /clear  → expires app cookies

const express = require('express');
const router  = express.Router();

router.post('/clear', (req,res)=>{
  const secure = process.env.NODE_ENV === 'production';
  const exp = new Date(0);

  // expire known cookies (httpOnly + non-httpOnly)
  const names = [
    'SWID','espn_s2','fein_has_espn',
    'ff_member','ff_espn_swid','ff_espn_s2',
    'ff_flow','ff_session_hint'
  ];
  for (const n of names) res.cookie(n, '', { expires: exp, httpOnly: n!=='fein_has_espn' && n!=='ff_session_hint', sameSite:'Lax', secure, path:'/' });

  res.json({ ok:true });
});

module.exports = router;
