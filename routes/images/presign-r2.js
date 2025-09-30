// routes/images/presign-r2.js
const express = require('express');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3, BUCKET } = require('./r2');

const router = express.Router();

/**
 * POST /api/images/presign
 * body: { content_type: string, kind?: 'avatars' | ... }
 * returns: { ok, key, url, public_url }
 */
router.post('/presign', express.json(), async (req, res) => {
  try {
    const { content_type, kind = 'avatars' } = req.body || {};
    const safeType = typeof content_type === 'string' && content_type ? content_type : 'image/webp';

    // simple unique-ish key
    const key = `${kind}/${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${
      safeType === 'image/png' ? '.png' : safeType === 'image/jpeg' ? '.jpg' : '.webp'
    }`;

    const cmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,                         // ✅ correct case
      ContentType: safeType,            // ✅ used by R2
      CacheControl: 'public, max-age=31536000, immutable',
      // ❌ do not set ACL with R2
    });

    // ✅ STRING URL
    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 });

    res.json({
      ok: true,
      key,
      url,                              // ✅ plain string
      public_url: `${process.env.R2_PUBLIC_BASE}/${key}`,
    });
  } catch (e) {
    console.error('[images/presign]', e);
    res.status(500).json({ ok: false, error: 'presign_failed' });
  }
});

module.exports = router;
