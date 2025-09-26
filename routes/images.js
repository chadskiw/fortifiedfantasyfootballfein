// routes/images.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer')();
const sharp  = require('sharp');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_KEY, secretAccessKey: process.env.R2_SECRET }
});
const BUCKET = process.env.R2_BUCKET;

router.post('/convert', multer.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ ok:false, error:'no_file' });

    // Decode, rotate (EXIF), fit inside 1024, encode to WebP ~85
    const out = await sharp(req.file.buffer)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    const key = `avatars/${Date.now()}-${crypto.randomUUID()}.webp`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: out, ContentType: 'image/webp'
    }));

    res.json({ ok:true, key, public_url: `https://img.fortifiedfantasy.com/${key}` });
  } catch (e) {
    console.error('[images.convert]', e);
    res.status(500).json({ ok:false, error:'convert_failed' });
  }
});

module.exports = router;
