// routes/images/index.js
const express = require('express');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer'); // for fallback upload
const crypto = require('crypto');

const router = express.Router();

const {
  R2_BUCKET,           // REQUIRED (R2/S3 bucket name)
  R2_PUBLIC_BASE,      // e.g. https://img.fortifiedfantasy.com
  R2_REGION,           // e.g. auto or us-east-1 for R2 S3-compatible
  R2_ENDPOINT,         // e.g. https://<accountid>.r2.cloudflarestorage.com
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
} = process.env;

const s3 = new S3Client({
  region: R2_REGION || 'auto',
  endpoint: R2_ENDPOINT,            // keep undefined if using AWS proper
  forcePathStyle: true,              // R2 usually needs this
  credentials: R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY ? {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  } : undefined,
});

// util: make a key under a “kind/” prefix
function makeKey(kind = 'uploads', ext = '') {
  const base = crypto.randomBytes(16).toString('hex');
  return `${kind}/${base}${ext ? (ext.startsWith('.') ? ext : '.'+ext) : ''}`;
}

// POST /api/images/presign  {content_type, kind}
// -> {ok, url, key, public_url}
router.post('/presign', async (req, res) => {
  try {
    if (!R2_BUCKET) {
      return res.status(500).json({ ok:false, error:'missing_bucket' });
    }
    const { content_type = 'image/webp', kind = 'avatars' } = req.body || {};
    const ext = content_type.split('/')[1] || 'bin';
    const key = makeKey(kind, ext);

    const put = new PutObjectCommand({
      Bucket: R2_BUCKET,                 // <-- THIS WAS MISSING
      Key: key,
      ContentType: content_type,
      ACL: 'public-read',                 // if your bucket allows it
    });

    const url = await getSignedUrl(s3, put, { expiresIn: 60 }); // 60s is fine
    const public_url = `${R2_PUBLIC_BASE?.replace(/\/$/,'')}/${key}`;
    res.json({ ok:true, url, key, public_url });
  } catch (err) {
    console.error('[images/presign] error:', err);
    res.status(500).json({ ok:false, error:'presign_failed' });
  }
});
