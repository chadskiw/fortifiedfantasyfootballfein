// src/lib/rs.js
// Tiny S3/R2 helper. If env not set, falls back to local tmp and returns a pseudo-URL.
// Backward compatible: still exports putAvatarFromDataUrl() returning a URL/path.
// New: keyFromUrl() and putAvatarReturnBoth() returning { key, url }.

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const RS_ENDPOINT   = process.env.RS_ENDPOINT  || process.env.S3_ENDPOINT || '';
const RS_REGION     = process.env.RS_REGION    || 'auto';
const RS_BUCKET     = process.env.RS_BUCKET    || '';
const RS_KEY        = process.env.RS_ACCESS_KEY_ID     || process.env.AWS_ACCESS_KEY_ID || '';
const RS_SECRET     = process.env.RS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
const RS_PUBLIC     = process.env.RS_PUBLIC_BASE || ''; // e.g. https://cdn.your.site

let client = null;
if (RS_BUCKET && RS_KEY && RS_SECRET) {
  client = new S3Client({
    region: RS_REGION,
    endpoint: RS_ENDPOINT || undefined,
    forcePathStyle: !!RS_ENDPOINT,
    credentials: { accessKeyId: RS_KEY, secretAccessKey: RS_SECRET }
  });
}

// build a deterministic-ish key
function makeAvatarKey(memberId = 'anon') {
  const safe = String(memberId).replace(/[^0-9A-Za-z._-]/g, '');
  return `avatars/${safe}/${Date.now()}.jpg`;
}

function publicUrlForKey(key) {
  if (!RS_PUBLIC) return null;
  return `${RS_PUBLIC.replace(/\/+$/,'')}/${String(key).replace(/^\/+/, '')}`;
}

// Convert a public URL/path back to a key for DB storage
function keyFromUrl(u) {
  if (!u) return null;
  const s = String(u);

  // If it's already a key-like path (no scheme/host), return trimmed path
  if (!/^https?:\/\//i.test(s)) {
    return s.replace(/^\/+/, ''); // "/avatars/..." -> "avatars/..."
  }
  // If we have a known CDN/origin base
  if (RS_PUBLIC && s.startsWith(RS_PUBLIC.replace(/\/+$/,'') + '/')) {
    return s.slice(RS_PUBLIC.replace(/\/+$/,'').length + 1);
  }
  // Generic: strip protocol and host (https://host/) leaving the path as key
  try {
    const url = new URL(s);
    return url.pathname.replace(/^\/+/, ''); // "/avatars/..." -> "avatars/..."
  } catch {
    return s;
  }
}

// OLD API (kept): returns a URL/path string
async function putAvatarFromDataUrl({ bytes, memberId='anon', contentType='image/jpeg' }) {
  const key = makeAvatarKey(memberId);

  if (!client) {
    // fallback to tmp folder (dev)
    const dir = path.join(process.cwd(), 'tmp-avatars');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive:true });
    const local = path.join(dir, key.replace(/\//g, '_'));
    fs.writeFileSync(local, bytes);
    // return a local path; FE won't load it over network, but this preserves signature
    return `/tmp/${key}`;
  }

  await client.send(new PutObjectCommand({
    Bucket: RS_BUCKET,
    Key: key,
    Body: bytes,
    ContentType: contentType,
    ACL: 'public-read'
  }));

  const url = publicUrlForKey(key) || `/${key}`;
  return url;
}

// NEW API: returns { key, url }
async function putAvatarReturnBoth({ bytes, memberId='anon', contentType='image/jpeg' }) {
  const urlOrPath = await putAvatarFromDataUrl({ bytes, memberId, contentType });
  const key = keyFromUrl(urlOrPath);
  const url = /^https?:\/\//i.test(urlOrPath) ? urlOrPath : (publicUrlForKey(key) || urlOrPath);
  return { key, url };
}

module.exports = {
  putAvatarFromDataUrl, // legacy (URL/path)
  putAvatarReturnBoth,  // preferred ({ key, url })
  keyFromUrl,
  publicUrlForKey
};
