// src/routes/images.js
const express = require('express');
const crypto  = require('crypto');
const aws4    = require('aws4'); // npm i aws4
const pool    = require('../db/pool');

const router = express.Router();

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_BASE = 'https://img.fortifiedfantasy.com'
} = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.warn('[images] Missing R2 env; presign will fail.');
}

function makeKey(ext=''){
  const id = crypto.randomBytes(16).toString('hex');
  const ts = Date.now();
  const safeExt = (ext||'').replace(/[^a-z0-9.]/ig,'').toLowerCase();
  return `${id}-${ts}${safeExt && !safeExt.startsWith('.') ? '.'+safeExt : safeExt}`;
}

function guessExtFromType(ct=''){
  const m = String(ct).toLowerCase().match(/image\/(png|jpeg|jpg|webp|gif|avif)/);
  if (!m) return '';
  const map = { jpeg:'.jpg', jpg:'.jpg', png:'.png', webp:'.webp', gif:'.gif', avif:'.avif' };
  return map[m[1]] || '';
}

// POST /api/images/presign { content_type }
router.post('/presign', async (req, res) => {
  try {
    const contentType = String(req.body?.content_type || 'application/octet-stream');
    const key = makeKey(guessExtFromType(contentType));

    // R2 S3 endpoint
    const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const path = `/${R2_BUCKET}/${key}`;
    const url  = `https://${host}${path}`;

    // Sign a PUT for ~5 minutes
    const now = new Date();
    const expires = 300; // seconds

    const opts = {
      host,
      path,
      method: 'PUT',
      headers: { 'content-type': contentType },
      service: 's3',
      region: 'auto',
    };

    aws4.sign(opts, { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY });

    // Build signed URL: include X-Amz-* query params
    const qs = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': opts.headers['Authorization'].match(/Credential=([^,]+)/)[1],
      'X-Amz-Date': opts.headers['x-amz-date'],
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': 'host;content-type',
      'X-Amz-Signature': opts.headers['Authorization'].match(/Signature=([0-9a-f]+)/)[1]
    });

    // NOTE: aws4 default signing wants unsigned payload unless you include X-Amz-Content-Sha256
    // We keep it simple: client must send the same Content-Type we used here.

    const upload_url = `${url}?${qs.toString()}`;
    const public_url = `${R2_PUBLIC_BASE}/${key}`;

    res.json({ ok:true, key, upload_url, public_url, content_type: contentType });
  } catch (e) {
    console.error('[images.presign]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// POST /api/images/commit { key, public_url, width?, height?, kind? }
router.post('/commit', async (req, res) => {
  try {
    const key = String(req.body?.key || '').trim();
    const url = String(req.body?.public_url || '').trim();
    if (!key || !url) return res.status(400).json({ ok:false, error:'missing_key_or_url' });

    const width  = Number(req.body?.width)  || null;
    const height = Number(req.body?.height) || null;
    const kind   = String(req.body?.kind || 'avatar');

    const r = await pool.query(
      `INSERT INTO ff_image (image_key, public_url, kind, width, height, created_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (image_key) DO UPDATE
         SET public_url = EXCLUDED.public_url,
             width = COALESCE(EXCLUDED.width, ff_image.width),
             height = COALESCE(EXCLUDED.height, ff_image.height)
       RETURNING image_id`,
      [key, url, kind, width, height]
    );

    res.json({ ok:true, image_id: r.rows[0].image_id, key, public_url: url });
  } catch (e) {
    console.error('[images.commit]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
