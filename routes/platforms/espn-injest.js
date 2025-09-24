// routes/platforms/espn-ingest.js
const express = require('express');
const { ingestAllFans, ingestOneFan } = require('../../src/api/espn-ingest-all');

const router = express.Router();
router.use(express.json());

// Simple header key guard (optional)
function checkKey(req, res, next) {
  const need = process.env.FEIN_ADMIN_KEY;
  if (!need) return next(); // no key configured
  if ((req.get('x-fein-key') || '') === need) return next();
  return res.status(401).json({ ok:false, error:'unauthorized' });
}

// POST /api/platforms/espn/ingest-all
router.post('/ingest-all', checkKey, async (_req, res) => {
  try {
    const out = await ingestAllFans();
    res.json({ ok:true, ...out });
  } catch (e) {
    console.error('[espn.ingest-all]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// POST /api/platforms/espn/ingest (body { swid })
router.post('/ingest', checkKey, async (req, res) => {
  try {
    const swid = String(req.body?.swid || '').trim();
    if (!swid) return res.status(400).json({ ok:false, error:'missing_swid' });
    const out = await ingestOneFan(swid);
    res.json(out);
  } catch (e) {
    console.error('[espn.ingest-one]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
