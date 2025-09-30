// /src/routes/images.js
// Presign PUT URLs for Cloudflare R2 (S3-compatible) + optional server-upload fallback.

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB cap

// ---- env ----
// R2 is S3-compatible (no region enforcement). Use 'auto' or 'us-east-1'.
const R2_ACCOUNT_ID       = process.env.R2_ACCOUNT_ID || ''; // required by public base if you use R2 endpoint style
const R2_ACCESS_KEY_ID    = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY= process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET           = process.env.R2_BUCKET || 'ff-media';
const R2_REGION           = process.env.R2_REGION || 'auto';
// public CDN/base for viewing files (e.g. https://img.fortifiedfantasy.com or R2 custom domain)
const PUBLIC_BASE         = (process.env.R2_PUBLIC_BASE || 'https://img.fortifiedfantasy.com').replace(/\/+$/,'');

// If you use R2 "S3 API" endpoint with account id:
const R2_ENDPOINT = process.env.R2_ENDPOINT
  || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);

if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !PUBLIC_BASE) {
  console.warn('[images] Missing R2 env vars. Presign/upload will fail without them.');
}

// src/routes/images.js (or wherever you build the S3 client)
const s3 = new S3Client({
  region: R2_REGION || 'auto',
  endpoint: R2_ENDPOINT,              // https://<account>.r2.cloudflarestorage.com
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  forcePathStyle: true,
});

// Remove flexible checksum headers for presigned PUTs
try { s3.middlewareStack.remove('flexibleChecksumsMiddleware'); } catch {}
s3.middlewareStack.addRelativeTo(
  (next) => async (args) => {
    const req = args.request;
    if (req && req.headers) {
      delete req.headers['x-amz-sdk-checksum-algorithm'];
      delete req.headers['x-amz-checksum-crc32'];
      delete req.headers['x-amz-checksum-crc32c'];
      delete req.headers['x-amz-checksum-sha1'];
      delete req.headers['x-amz-checksum-sha256'];
    }
    return next(args);
  },
  { relation: 'before', toMiddleware: 'awsAuthMiddleware', name: 'stripChecksums' }
);

function safeContentType(s) {
  const v = String(s || '').toLowerCase();
  if (!v || /octet-stream/.test(v)) return 'image/webp'; // default
  if (!/^image\//.test(v)) return 'image/webp';
  return v;
}

function genKey({ kind='avatars', member_id=null, ext='webp' }) {
  const ts = Date.now();
  const rand = crypto.randomBytes(6).toString('hex');
  const owner = member_id ? String(member_id) : 'anon';
  return `${kind}/${owner}/${ts}-${rand}.${ext}`.replace(/\/{2,}/g,'/');
}

module.exports = function createImagesRouter(){
  const router = express.Router();

  // Preflight to be safe
  router.options('*', (_req, res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-espn-swid,x-espn-s2',
      'Access-Control-Max-Age': '600',
    });
    res.sendStatus(204);
  });

  // JSON body
  router.use(express.json({ limit: '1mb' }));

  // POST /api/images/presign { content_type?, kind?, ext? }
  // -> { ok, url, key, public_url, headers }
  router.post('/presign', async (req, res) => {
    try {
      const member_id = req.cookies?.ff_member || null;
      const contentType = safeContentType(req.body?.content_type || req.body?.contentType);
      const kind = (req.body?.kind || 'avatars').toString();
      let ext = (req.body?.ext || '').replace(/^\.+/,'').toLowerCase();
      if (!ext) {
        ext = contentType === 'image/png' ? 'png'
            : contentType === 'image/jpeg' ? 'jpg'
            : 'webp';
      }

      const key = genKey({ kind, member_id, ext });
      const putCmd = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ContentType: contentType,
        // You can also add CacheControl if desired:
        // CacheControl: 'public, max-age=31536000, immutable',
      });

      // 5 minutes URL
      const url = await getSignedUrl(s3, putCmd, { expiresIn: 300 });

      const public_url = `${PUBLIC_BASE}/${key}`;
      res.set('Cache-Control', 'no-store');
      return res.json({
        ok: true,
        url,
        key,
        public_url,
        headers: { 'content-type': contentType }
      });
    } catch (e) {
      console.error('[images.presign] error:', e);
      return res.status(500).json({ ok:false, error:'presign_failed' });
    }
  });

  // POST /api/images/upload  (server-side upload fallback)
  // multipart/form-data; field: file; query/body: kind?
  router.post('/upload', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok:false, error:'no_file' });
      const member_id = req.cookies?.ff_member || null;
      const kind = (req.body?.kind || req.query?.kind || 'avatars').toString();
      const ext = (req.file.mimetype === 'image/png' ? 'png'
                : req.file.mimetype === 'image/jpeg' ? 'jpg'
                : 'webp');

      const key = genKey({ kind, member_id, ext });
      await s3.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || 'application/octet-stream',
      }));
      const public_url = `${PUBLIC_BASE}/${key}`;
      res.set('Cache-Control', 'no-store');
      return res.json({ ok:true, key, public_url });
    } catch (e) {
      console.error('[images.upload] error:', e);
      return res.status(500).json({ ok:false, error:'upload_failed' });
    }
  });

  return router;
};
