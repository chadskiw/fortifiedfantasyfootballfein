// routes/images/index.js
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('crypto');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const r2 = require('../../src/r2');

const upload = multer({ limits: { fileSize: 16 * 1024 * 1024 } }); // 16MB cap
const router = express.Router();


router.post('/presign', require('./presign-r2')); // uses r2.js
router.post('/upload', require('./upload-r2'));   // uses r2.js





function normalizeKind(input, fallback = 'misc') {
  const cleaned = String(input || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return cleaned || fallback;
}

function buildKey(kind = 'misc', ext = 'webp') {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(6).toString('hex');
  return `${kind}/${ts}-${rand}.${ext}`;
}

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const bucket = process.env.R2_BUCKET;
    if (!bucket) return res.status(500).json({ ok:false, error:'bucket_missing' });
    if (!req.file) return res.status(400).json({ ok:false, error:'file_required' });

    const kind = normalizeKind(req.query.kind || 'misc');
    const ext = (req.file.mimetype === 'image/png') ? 'png'
             : (req.file.mimetype === 'image/webp') ? 'webp'
             : (req.file.mimetype === 'image/jpeg') ? 'jpg' : 'bin';
    const key = buildKey(kind, ext);

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

router.post('/convert', upload.single('file'), async (req, res) => {
  try {
    const bucket = process.env.R2_BUCKET;
    if (!bucket) return res.status(500).json({ ok: false, error: 'bucket_missing' });
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: 'file_required' });
    if (!/^image\//i.test(file.mimetype || '')) {
      return res.status(415).json({ ok: false, error: 'unsupported_media_type' });
    }

    const kind = normalizeKind(req.body?.kind || req.query?.kind || 'party');
    const maxParam = Number(req.body?.max || req.query?.max);
    const maxDimension = Number.isFinite(maxParam)
      ? Math.min(Math.max(320, maxParam), 4096)
      : 1600;

    const converted = await sharp(file.buffer, { failOnError: false })
      .rotate()
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
        fastShrinkOnLoad: true,
      })
      .webp({ quality: 86, effort: 4 })
      .toBuffer();

    const key = buildKey(kind, 'webp');
    await r2.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: converted,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );

    const public_base = process.env.R2_PUBLIC_BASE || process.env.IMG_CDN_BASE || '';
    const public_url = public_base ? `${public_base.replace(/\/+$/, '')}/${key}` : null;

    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, key, public_url, bytes: converted.length });
  } catch (err) {
    console.error('[images/convert] error', err);
    if (err?.message && /unsupported image format/i.test(err.message)) {
      return res.status(415).json({ ok: false, error: 'unsupported_media_type' });
    }
    return res.status(500).json({ ok: false, error: 'image_convert_failed' });
  }
});

module.exports = router;
