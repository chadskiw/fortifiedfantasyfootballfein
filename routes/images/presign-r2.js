// routes/images/presign-r2.js
const express = require('express');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3, BUCKET } = require('./r2');
const crypto = require('crypto');
const router = express.Router();
function genKey({ kind='avatars', ext='webp' }) {
  const ts   = Date.now().toString(36);
  const rand = crypto.randomBytes(8).toString('hex').slice(0,12);
  return `${kind}/${ts}-${rand}.${ext}`;   // e.g. avatars/lph0qo-7a3f1b2c3d.webp
}
/**
 * POST /api/images/presign
 * body: { content_type: string, kind?: 'avatars' | ... }
 * returns: { ok, key, url, public_url }
 */
router.post('/presign', async (req, res) => {
  const contentType = String(req.body?.content_type || '').toLowerCase() || 'image/webp';
  const kind = (req.body?.kind || 'avatars').toString();
  const ext  = contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : 'webp';

  const key = genKey({ kind, member_id: req.cookies?.ff_member || null, ext });

  const cmd = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
    // CacheControl: 'public, max-age=31536000, immutable'   // optional; safe to add
  });

  const url = await getSignedUrl(s3, cmd, {
    expiresIn: 300,
    // keep content-type as a header (optional but nice)
    unhoistableHeaders: new Set(['content-type']),
  });

  res.json({
    ok: true,
    url,
    key,
    public_url: `${PUBLIC_BASE}/${key}`,
    headers: { 'content-type': contentType }
  });
});


module.exports = router;
