// routes/images.js
const express = require('express');
const crypto  = require('crypto');
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
    const { content_type } = req.body || {};
    const key = `avatars/${Date.now()}-${crypto.randomUUID()}`;
    const cmd = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      ContentType: content_type || 'application/octet-stream',
    });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 });
    res.json({
      ok: true,
      type: 'put',
      url,
      key,
      public_url: `https://img.fortifiedfantasy.com/${key}`,
    });
  } catch (e) {
    console.error('[images.presign]', e);
    res.status(500).json({ ok: false, error: 'presign_failed' });
  }
});

module.exports = router;
