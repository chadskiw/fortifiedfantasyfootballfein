// routes/images/presign.js
// Issues a short-lived presigned PUT URL for direct browser upload to R2.
// Returns: { ok, url, key, public_url }

const express = require('express');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const router = express.Router();

/** R2/S3 client (Cloudflare R2 uses "auto" region + custom endpoint) */
const s3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT, // e.g. https://<accountid>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

function uuid() { return crypto.randomBytes(16).toString('hex'); }
function safeKind(k) { return /^(avatars|images)$/i.test(k || '') ? k : 'avatars'; }

router.post('/', express.json(), async (req, res) => {
  try {
    // identify the member (whatever cookie you already set)
    const memberId =
      req.cookies?.ff_member ||
      req.cookies?.ff_member_id ||
      req.cookies?.member_id ||
      'anon';

    const kind = safeKind(req.body?.kind);
    const requestedType = String(req.body?.content_type || '').toLowerCase();
    // only allow safe image types; default to webp
    const contentType = ['image/webp', 'image/jpeg', 'image/png'].includes(requestedType)
      ? requestedType
      : 'image/webp';

    const ext = contentType === 'image/png' ? 'png'
              : contentType === 'image/jpeg' ? 'jpg'
              : 'webp';

    const key = `${kind}/${memberId}/${uuid()}.${ext}`;

    // one minute is plenty for a browser PUT
    const cmd = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 });

    const publicBase = process.env.PUBLIC_IMG_BASE || 'https://img.fortifiedfantasy.com';
    res.json({ ok: true, url, key, public_url: `${publicBase}/${key}` });
  } catch (e) {
    console.error('[images/presign] error:', e);
    res.status(500).json({ ok: false, error: 'presign_failed' });
  }
});

module.exports = router;
