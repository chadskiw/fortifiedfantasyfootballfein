// routes/images.js
const express = require('express');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const router = express.Router();

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_KEY,
    secretAccessKey: process.env.R2_SECRET,
  },
});

router.post('/presign', async (req, res) => {
  try {
    const ct = String(req.body?.content_type || '').trim();
    if (!ct) return res.status(400).json({ ok:false, error:'missing_content_type' });

    const ext = (ct.split('/')[1] || 'bin').toLowerCase();
    const key = `avatars/${Date.now()}-${crypto.randomUUID()}.${ext}`;

    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        ContentType: ct,          // no x-amz-acl on R2
      }),
      { expiresIn: 60 }
    );

    res.json({
      ok: true,
      key,
      upload_url: url,
      public_url: `https://img.fortifiedfantasy.com/${key}`,
    });
  } catch (e) {
    console.error('[images.presign]', e);
    res.status(500).json({ ok:false, error:'presign_failed' });
  }
});

module.exports = router;
