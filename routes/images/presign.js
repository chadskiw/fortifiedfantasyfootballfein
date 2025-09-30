// routes/images/presign.js
const express = require('express');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const r2 = require('../../src/r2');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { content_type, kind = 'misc' } = req.body || {};
    if (!content_type) return res.status(400).json({ ok:false, error:'content_type_required' });

    const bucket = process.env.R2_BUCKET;
    if (!bucket) return res.status(500).json({ ok:false, error:'bucket_missing' });

    const ext = content_type === 'image/png' ? 'png'
             : content_type === 'image/webp' ? 'webp'
             : content_type === 'image/jpeg' ? 'jpg' : 'bin';

    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 10);
    const key = `${kind}/${ts}-${rand}.${ext}`;

    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: content_type,
      // (no ACL on R2; bucket public access handled at CDN layer)
    });

    const url = await getSignedUrl(r2, cmd, { expiresIn: 60 }); // seconds
    const public_base = process.env.R2_PUBLIC_BASE || process.env.IMG_CDN_BASE || '';
    const public_url = public_base ? `${public_base.replace(/\/+$/,'')}/${key}` : null;

    res.json({ ok:true, url, key, public_url });
  } catch (err) {
    console.error('[images/presign] error:', err);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
