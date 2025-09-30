// src/r2.js
const { S3Client } = require('@aws-sdk/client-s3');

const r2 = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT, // NO bucket in the URL
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true, // important for R2 with custom endpoint
});

module.exports = r2;
