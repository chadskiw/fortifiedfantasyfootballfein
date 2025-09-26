const express = require('express');
const router  = express.Router();

router.get('/status', (req, res) => {
  const c = req.cookies || {};
  // check all cookie variants you’ve used
  const hasESPN = !!(
    (c.SWID && (c.espn_s2 || c.ESPN_S2)) ||
    (c.ff_espn_swid && c.ff_espn_s2) ||
    c.has_espn === '1' || c.ff_has_espn === '1' || c.fein_has_espn === '1'
  );
  res.set('Cache-Control','no-store');
  res.json({ ok: true, has_espn: hasESPN });
});

module.exports = router;
