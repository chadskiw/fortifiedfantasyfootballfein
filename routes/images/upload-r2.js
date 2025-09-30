const express = require('express');
const multer  = require('multer');
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { s3, BUCKET } = require('./r2');
const upload = multer({ limits: { fileSize: 6 * 1024 * 1024 } }); // 6MB guard
const router = express.Router();


 const IMG_CDN_BASE = 'https://img.fortifiedfantasy.com'


function makeKey(kind, ext){
  const k = (kind || 'avatars').toLowerCase();
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${k}/${id}.${ext}`;
}

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'no_file' });
    const kind = (req.query.kind || 'avatars').toLowerCase();
    const ct = req.file.mimetype || 'image/webp';
    const ext = ct.includes('png') ? 'png' : ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : 'webp';
    const key = makeKey(kind, ext);

    await s3.send(new PutObjectCommand({ Bucket: BUCKET, key, ContentType }));

    res.json({ ok:true, key, public_url: `${IMG_CDN_BASE}/${key}` });
  } catch (e) {
    console.error('[images/upload] error', e);
    res.status(500).json({ ok:false, error:'upload_failed' });
  }
});

module.exports = router;
