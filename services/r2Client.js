// services/r2Client.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const R2_ACCOUNT_ID = 'ceed10c7e8a633e17423b703fd81fbf0';
const R2_BUCKET = process.env.R2_BUCKET || 'tt-pics';

console.log('[R2] using bucket =', R2_BUCKET);
console.log(
  '[R2] endpoint =',
  `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
);

const s3 = new S3Client({
  region: 'auto', // required for R2 
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

  await s3.send(command);
}

module.exports = { uploadToR2 };
