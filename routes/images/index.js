// routes/images/index.js  (ensure this is what /api/images mounts)
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, // path-style
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET || 'ff-media';  // <-- ff-media
const PUBLIC_HOST = process.env.R2_PUBLIC_HOST || 'img.fortifiedfantasy.com';

function extFrom(type='') {
  if (type.includes('webp')) return 'webp';
  if (type.includes('png'))  return 'png';
  return 'jpg';
}

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'no_file' });

    const kind = String(req.query.kind || 'avatars');
    const ct = req.file.mimetype || 'image/jpeg';
    const key = `${kind}/${crypto.randomUUID()}.${extFrom(ct)}`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: ct,
      // IMPORTANT: no ACL on R2
    }));

    res.json({ ok:true, key, public_url: `https://${PUBLIC_HOST}/${key}` });
  } catch (e) {
    console.error('[images/upload] error', e);
    res.status(500).json({ ok:false, error: e.Code || 'upload_failed' });
  }
});

module.exports = router;
