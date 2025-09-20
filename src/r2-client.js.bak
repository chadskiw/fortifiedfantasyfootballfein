// src/r2-client.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function presignAvatarPut({ key, contentType }) {
  const cmd = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,        // e.g. "ff-media"
    Key: key,
    ContentType: contentType || 'image/webp',
    CacheControl: 'public, max-age=31536000, immutable',
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 60 }); // 60s
  return { url };
}

module.exports = { s3, presignAvatarPut };
