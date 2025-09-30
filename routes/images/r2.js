// routes/images/r2.js
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET   = process.env.R2_BUCKET;                         // ff-media
const ENDPOINT = process.env.R2_ENDPOINT;                       // https://<account>.r2.cloudflarestorage.com
const REGION   = process.env.R2_REGION || 'auto';
const PUB_BASE = (process.env.R2_PUBLIC_BASE || '').replace(/\/+$/,'');

if (!BUCKET || !ENDPOINT) {
  console.warn(`[R2] missing env — BUCKET=${BUCKET} ENDPOINT=${ENDPOINT}`);
}

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,              // account root (NOT including bucket)
  forcePathStyle: true,            // so URL becomes /ff-media/<key>
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ---- helpers ---------------------------------------------------------------
function makeKey(kind = 'misc', ext = 'webp') {
  const id = crypto.randomBytes(16).toString('hex');
  const cleanExt = String(ext || 'webp').replace(/^\./,'').toLowerCase();
  return `${kind}/${id}.${cleanExt}`;
}

function publicUrl(key) {
  if (!PUB_BASE) return null;
  return `${PUB_BASE}/${key}`;
}

/**
 * Presign a PUT for the given key.
 * Returns { url, key, public_url }.
 */
async function presignPut({ key, contentType = 'application/octet-stream', acl = 'private', expiresIn = 60 }) {
  if (!key) throw new Error('key required');

  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    ACL: acl,                 // R2 supports S3-compatible ACL param; good to include in the signature
  });

  const url = await getSignedUrl(s3, cmd, { expiresIn });
  return { url, key, public_url: publicUrl(key) };
}

module.exports = { s3, BUCKET, makeKey, publicUrl, presignPut };
