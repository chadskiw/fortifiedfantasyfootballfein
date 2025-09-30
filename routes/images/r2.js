// routes/images/r2.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  IMG_CDN_BASE = ''
} = process.env;

function assertEnv() {
  const miss = ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET']
    .filter(k => !process.env[k]);
  if (miss.length) throw new Error(`R2 env missing: ${miss.join(', ')}`);
}

function s3() {
  assertEnv();
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY
    }
  });
}

function makeKey(kind='misc', ext='webp') {
  const id = crypto.randomBytes(16).toString('hex');
  return `${kind}/${id}.${ext}`;
}

function publicUrl(key) {
  if (IMG_CDN_BASE) return `${IMG_CDN_BASE.replace(/\/$/,'')}/${key}`;
  // fallback (not ideal for prod)
  return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${key}`;
}

async function presignPut({ contentType, key }) {
  const client = s3();
  const cmd = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
    ACL: 'private'
  });
  const url = await getSignedUrl(client, cmd, { expiresIn: 60 }); // 60s
  return url;
}

async function putObject({ key, body, contentType }) {
  const client = s3();
  const cmd = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    ACL: 'private'
  });
  await client.send(cmd);
  return publicUrl(key);
}

module.exports = { makeKey, publicUrl, presignPut, putObject };
