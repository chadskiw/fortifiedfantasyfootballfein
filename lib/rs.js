// src/lib/rs.js
// Tiny S3/R2 helper. If env not set, falls back to local tmp and returns a pseudo-URL.

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const RS_ENDPOINT  = process.env.RS_ENDPOINT  || process.env.S3_ENDPOINT || '';
const RS_REGION    = process.env.RS_REGION    || 'auto';
const RS_BUCKET    = process.env.RS_BUCKET    || '';
const RS_KEY       = process.env.RS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '';
const RS_SECRET    = process.env.RS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
const RS_PUBLIC    = process.env.RS_PUBLIC_BASE || ''; // e.g. https://cdn.your.site

let client = null;
if (RS_BUCKET && RS_KEY && RS_SECRET) {
  client = new S3Client({
    region: RS_REGION,
    endpoint: RS_ENDPOINT || undefined,
    forcePathStyle: !!RS_ENDPOINT,
    credentials: { accessKeyId: RS_KEY, secretAccessKey: RS_SECRET }
  });
}

async function putAvatarFromDataUrl({ bytes, memberId='anon', contentType='image/jpeg' }){
  const key = `avatars/${memberId}-${Date.now()}.jpg`;
  if (!client) {
    // fallback to tmp folder (dev)
    const dir = path.join(process.cwd(), 'tmp-avatars');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive:true });
    fs.writeFileSync(path.join(dir, key.replace(/\//g,'_')), bytes);
    return `/tmp/${key}`; // not public; dev-only
  }
  await client.send(new PutObjectCommand({
    Bucket: RS_BUCKET,
    Key: key,
    Body: bytes,
    ContentType: contentType,
    ACL: 'public-read'
  }));
  return RS_PUBLIC ? `${RS_PUBLIC.replace(/\/$/,'')}/${key}` : `/${key}`;
}

module.exports = { putAvatarFromDataUrl };
