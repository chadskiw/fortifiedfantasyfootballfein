// routes/images/r2.js
const { S3Client } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT, // https://<account>.r2.cloudflarestorage.com
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

module.exports = { s3, BUCKET: process.env.R2_BUCKET };
