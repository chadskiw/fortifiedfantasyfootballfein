// TRUE_LOCATION: src/middleware/r2.js
// IN_USE: TRUE
// src/middleware/r2.js  (server uploader)
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

function extFromType(ct=''){ ct=String(ct).toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg')||ct.includes('jpg')) return 'jpg';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('avif')) return 'avif';
  if (ct.includes('heic')) return 'heic';
  if (ct.includes('webp')) return 'webp';
  return 'webp';
}
function makeKey(ffid='ANON0000', ext='webp'){
  const now = new Date();
  const y=now.getUTCFullYear(), m=String(now.getUTCMonth()+1).padStart(2,'0'), d=String(now.getUTCDate()).padStart(2,'0');
  const ts=now.getTime(), rand=crypto.randomBytes(3).toString('hex');
  return `${ffid}/${y}/${m}/${d}/${ts}-${rand}.${ext}`;
}

async function putThumbToR2(buf, contentType='image/webp', ffid='ANON0000'){
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const ext = extFromType(contentType);
  const key = makeKey(ffid, ext);
  const resp = await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buf,
    ContentType: contentType,
    Metadata: { ffid }
  }));
  const etag = resp.ETag && String(resp.ETag).replace(/"/g,'');
  const url = process.env.R2_PUBLIC_BASE
    ? `${process.env.R2_PUBLIC_BASE.replace(/\/+$/,'')}/${encodeURI(key)}`
    : undefined;
  return { key, etag, url };
}

module.exports = { putThumbToR2 };
