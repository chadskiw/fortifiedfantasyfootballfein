// src/middleware/requireEspnAuth.js
module.exports = function requireEspnAuth(req, res, next) {
  const c = req.cookies || {};
  const swid = c.SWID || c.swid || req.get('x-espn-swid');
  const s2   = c.espn_s2 || c['espn_s2'] || req.get('x-espn-s2');

  if (!swid || !s2) {
    return res.status(401).json({
      ok: false,
      code: 'NEED_AUTH',
      msg: 'Missing ESPN auth (SWID / espn_s2)',
    });
  }

  // pass along for handlers to use
  req.espnAuth = { swid, s2 };
  next();
};
