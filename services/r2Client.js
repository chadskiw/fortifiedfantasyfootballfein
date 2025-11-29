// services/r2Client.js
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || 'ceed10c7e8a633e17423b703fd81fbf0';
const R2_BUCKET = process.env.R2_BUCKET || 'tt-pics';

console.log('[R2] init', {
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  bucket: R2_BUCKET,
});

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function uploadToR2({ key, body, contentType }) {
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  });

  try {
    const res = await s3.send(command);
    console.log('[R2] PutObject OK', {
      bucket: R2_BUCKET,
      key,
      etag: res.ETag,
    });
    return res;
  } catch (err) {
    console.error('[R2] PutObject ERROR', {
      bucket: R2_BUCKET,
      key,
      code: err.name || err.code,
      message: err.message,
      meta: err.$metadata,
    });
    throw err; // important: bubble up so /upload becomes 500
  }
}

async function headR2({ key }) {
  const command = new HeadObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
  });
  return s3.send(command);
}

module.exports = {
  uploadToR2,
  headR2,
};
