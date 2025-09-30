// routes/images/presign-r2.js
const express = require('express');
const crypto = require('crypto');
const { makeKey, publicUrl, presignPut } = require('./r2');

const router = express.Router();

router.post('/', express.json(), async (req, res) => {
  try {
    const kind = (req.body?.kind || 'avatars').toLowerCase();
    const requestedType = String(req.body?.content_type || '').toLowerCase();
    const contentType = ['image/webp','image/jpeg','image/png'].includes(requestedType)
      ? requestedType : 'image/webp';

    const ext = contentType === 'image/png' ? 'png'
              : contentType === 'image/jpeg' ? 'jpg'
              : 'webp';

    const key = makeKey(kind, ext);
    const url = await presignPut({ contentType, key });

    res.json({ ok:true, url, key, public_url: publicUrl(key) });
  } catch (e) {
    console.error('[images/presign-r2] error', e);
    res.status(500).json({ ok:false, error:'presign_failed' });
  }
});

module.exports = router;
