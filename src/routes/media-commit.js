// TRUE_LOCATION: src/routes/media-commit.js
// IN_USE: FALSE
// routes/media-commit.js
const express = require('express');
const { ensureInteracted } = require('./identity');
const { saveImageMeta } = require('../src/save-image-meta');

const router = express.Router();

/**
 * POST /api/media/commit
 * body: { key, etag?, bytes?, format?, page? }
 */
router.post('/commit', express.json(), async (req, res) => {
  try {
    const { code } = ensureInteracted(req, res);
    const { key, etag, bytes, format, page } = req.body || {};
    if (!key) return res.status(400).json({ ok: false, error: 'missing_key' });

    const ua = req.get('user-agent') || '';
    const memberId = await saveImageMeta({
      code, key, etag, bytes: Number(bytes) || 0, format, page, ua
    });

    res.json({
      ok: true,
      memberId,
      key,
      url: `${process.env.ASSET_BASE}/${key}`,
    });
  } catch (e) {
    console.error('[media/commit]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
