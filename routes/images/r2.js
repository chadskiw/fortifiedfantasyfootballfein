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

// src/routes/images.js (or wherever you build the S3 client)
const s3 = new S3Client({
  region: R2_REGION || 'auto',
  endpoint: R2_ENDPOINT,              // https://<account>.r2.cloudflarestorage.com
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  forcePathStyle: true,
});

// Remove flexible checksum headers for presigned PUTs
try { s3.middlewareStack.remove('flexibleChecksumsMiddleware'); } catch {}
s3.middlewareStack.addRelativeTo(
  (next) => async (args) => {
    const req = args.request;
    if (req && req.headers) {
      delete req.headers['x-amz-sdk-checksum-algorithm'];
      delete req.headers['x-amz-checksum-crc32'];
      delete req.headers['x-amz-checksum-crc32c'];
      delete req.headers['x-amz-checksum-sha1'];
      delete req.headers['x-amz-checksum-sha256'];
    }
    return next(args);
  },
  { relation: 'before', toMiddleware: 'awsAuthMiddleware', name: 'stripChecksums' }
);


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
