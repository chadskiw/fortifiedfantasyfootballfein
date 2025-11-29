// services/r2Client.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const R2_ENDPOINT =
  process.env.R2_ENDPOINT ||
  'https://ceed10c7e8a633e17423b703fd81fbf0.r2.cloudflarestorage.com';

const R2_BUCKET = process.env.R2_BUCKET || 'tt-pics';

const r2Client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
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

  await r2Client.send(command);
  return { key };
}

module.exports = {
  uploadToR2,
  R2_BUCKET,
  R2_ENDPOINT,
};
