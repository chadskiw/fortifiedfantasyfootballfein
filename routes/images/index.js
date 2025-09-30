// routes/images/index.js
const express = require('express');
const multer = require('multer');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const r2 = require('../../src/r2');

const upload = multer(); // memory storage
const router = express.Router();

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const bucket = process.env.R2_BUCKET;
    if (!bucket) return res.status(500).json({ ok:false, error:'bucket_missing' });
    if (!req.file) return res.status(400).json({ ok:false, error:'file_required' });

    const kind = String(req.query.kind || 'misc');
    const ext = (req.file.mimetype === 'image/png') ? 'png'
             : (req.file.mimetype === 'image/webp') ? 'webp'
             : (req.file.mimetype === 'image/jpeg') ? 'jpg' : 'bin';
    const key = `${kind}/${Date.now()}-${Math.random().toString(36).slice(2,10)}.${ext}`;

    await r2.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'application/octet-stream',
    }));

    const public_base = process.env.R2_PUBLIC_BASE || process.env.IMG_CDN_BASE || '';
    const public_url = public_base ? `${public_base.replace(/\/+$/,'')}/${key}` : null;

    res.json({ ok:true, key, public_url });
  } catch (err) {
    console.error('[images/upload] error', err);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
