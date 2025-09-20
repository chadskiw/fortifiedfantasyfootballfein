// TRUE_LOCATION: src/routes/media-presign.js
// IN_USE: FALSE
// routes/media-presign.js
const express = require('express');
const crypto = require('crypto');
const { presignAvatarPut } = require('../src/r2-client');
const { ensureInteracted } = require('./identity');

const router = express.Router();

router.post('/presign', async (req, res) => {
  try {
    const { code } = ensureInteracted(req, res); // your 8-char cookie
    const { ext = 'webp', sha256 } = req.body || {};

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');

    const token = sha256 || crypto.randomBytes(16).toString('hex');
    const key = `thumbs/${yyyy}/${mm}/${code}/v1/${token}.${ext}`;

    const { url } = await presignAvatarPut({
      key,
      contentType: `image/${ext}`,
    });

    res.json({ ok: true, key, url });
  } catch (e) {
    console.error('[media/presign]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
