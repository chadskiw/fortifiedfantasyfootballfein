// routes/images/presign.js
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  region: 'auto',
  // PATH-STYLE endpoint (required for R2 + proper preflight):
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET || 'ff-media';                 // <— default to ff-media
const PUBLIC_HOST = process.env.R2_PUBLIC_HOST || 'img.fortifiedfantasy.com'; // CNAME -> R2 public bucket

function extFrom(type='') {
  if (type.includes('webp')) return 'webp';
  if (type.includes('png'))  return 'png';
  return 'jpg';
}

module.exports = async (req, res) => {
  try {
    const { content_type = 'image/jpeg', kind = 'avatars' } = req.body || {};
    const key = `${kind}/${crypto.randomUUID()}.${extFrom(content_type)}`;

    const cmd = new PutObjectCommand({
      Bucket: BUCKET,            // <— ff-media
      Key: key,
      ContentType: content_type,
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 });

    res.json({
      ok: true,
      url,                       // presigned PUT URL
      key,                       // store this in DB
      public_url: `https://${PUBLIC_HOST}/${key}`, // use for immediate preview
    });
  } catch (e) {
    console.error('[images/presign] error:', e);
    res.status(500).json({ ok:false, error:'presign_failed' });
  }
};
