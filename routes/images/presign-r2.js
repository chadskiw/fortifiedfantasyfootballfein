// routes/images/presign-r2.js
const express = require('express');
const crypto = require('crypto');
const { makeKey, publicUrl} = require('./r2');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, BUCKET } = require('./r2');
const router = express.Router();

// routes/images/presign.js (or presign-r2.js)
const { s3, BUCKET } = require('./r2');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

app.post('/api/images/presign', async (req, res) => {
  try {
    const { content_type, kind = 'avatars' } = req.body || {};
    const key = `${kind}/${Date.now().toString(36)}${Math.random().toString(36).slice(2)}.webp`;

    const cmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: content_type || 'application/octet-stream',
      // ❌ do NOT set ACL with R2
      // ACL: 'private',
      // Optional: CacheControl for avatars
      CacheControl: 'public, max-age=31536000, immutable',
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 }); // <-- this MUST be a string
    res.json({ ok: true, key, url, public_url: `${process.env.R2_PUBLIC_BASE}/${key}` });
  } catch (e) {
    console.error('[images/presign]', e);
    res.status(500).json({ ok: false, error: 'presign_failed' });
  }
});

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
    const url = await new PutObjectCommand({ Bucket: BUCKET, key, contentType });

    res.json({ ok:true, url, key, public_url: publicUrl(key) });
  } catch (e) {
    console.error('[images/presign-r2] error', e);
    res.status(500).json({ ok:false, error:'presign_failed' });
  }
});

module.exports = router;
