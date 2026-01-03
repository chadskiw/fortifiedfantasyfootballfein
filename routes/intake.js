const express = require('express');
const { z } = require('zod');
const { Pool } = require('pg');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const router = express.Router();

// --- minimal env ---
const DATABASE_URL = process.env.DATABASE_URL;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_REGION = process.env.R2_REGION || 'auto';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL; // optional

if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL');
}

if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  throw new Error(
    'Missing R2 env vars (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)'
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const s3 = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// --- helpers ---
function safeFilename(name) {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'upload.bin';
}

function publicUrlFor(key) {
  if (!R2_PUBLIC_BASE_URL) return null;
  return `${R2_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${key}`;
}

// --- schemas ---
const CreateIntakeSchema = z.object({
  businessName: z.string().min(1).max(120),
  contactName: z.string().min(1).max(120),
  email: z.string().email().max(200),
  phone: z.string().max(40).optional().nullable(),
  category: z.enum(['kids_games', 'carplay', 'other']),
  budgetRange: z.string().max(80).optional().nullable(),
  timeline: z.string().max(80).optional().nullable(),
  summary: z.string().max(240).optional().nullable(),
  details: z.string().max(8000).optional().nullable(),
  links: z.string().max(2000).optional().nullable(),
});

const UuidParam = z.object({ id: z.string().uuid() });

const PresignSchema = z.object({
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(120).optional().nullable(),
});

const ConfirmSchema = z.object({
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(120).optional().nullable(),
  fileSize: z.number().int().nonnegative().optional().nullable(),
  storageKey: z.string().min(1).max(500),
  publicUrl: z.string().url().optional().nullable(),
  sha256: z.string().max(128).optional().nullable(),
});

// --- middleware ---
router.use(express.json({ limit: '1mb' }));

// ------------------------------------------------------------
// POST /api/intake
// Creates an intake submission, returns { id }
// ------------------------------------------------------------
router.post('/', async (req, res) => {
  const body = CreateIntakeSchema.parse(req.body);

  const q = `
    insert into intake_requests
      (business_name, contact_name, email, phone, category, budget_range, timeline, summary, details, links)
    values
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    returning id
  `;

  const values = [
    body.businessName,
    body.contactName,
    body.email,
    body.phone ?? null,
    body.category,
    body.budgetRange ?? null,
    body.timeline ?? null,
    body.summary ?? null,
    body.details ?? null,
    body.links ?? null,
  ];

  const result = await pool.query(q, values);
  res.status(200).json({ id: result.rows[0].id });
});

// ------------------------------------------------------------
// POST /api/intake/:id/assets/presign
// Returns a presigned PUT URL for direct upload to R2/S3
// ------------------------------------------------------------
router.post('/:id/assets/presign', async (req, res) => {
  const { id } = UuidParam.parse(req.params);
  const body = PresignSchema.parse(req.body);

  const exists = await pool.query('select 1 from intake_requests where id=$1', [id]);
  if (exists.rowCount === 0) {
    return res.status(404).json({ error: 'Intake not found' });
  }

  const clean = safeFilename(body.fileName);
  const key = `intake/${id}/${Date.now()}_${crypto.randomUUID()}_${clean}`;

  const cmd = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: body.mimeType ?? undefined,
  });

  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 60 * 5 });
  const pub = publicUrlFor(key);

  res.status(200).json({
    uploadUrl,
    storageKey: key,
    publicUrl: pub,
  });
});

// ------------------------------------------------------------
// POST /api/intake/:id/assets/confirm
// Records the uploaded file in intake_assets (after client uploads)
// ------------------------------------------------------------
router.post('/:id/assets/confirm', async (req, res) => {
  const { id } = UuidParam.parse(req.params);
  const body = ConfirmSchema.parse(req.body);

  if (!body.storageKey.startsWith(`intake/${id}/`)) {
    return res.status(400).json({ error: 'storageKey must start with the intake folder' });
  }

  const q = `
    insert into intake_assets
      (intake_id, file_name, mime_type, file_size, storage_key, public_url, sha256)
    values
      ($1,$2,$3,$4,$5,$6,$7)
    returning id
  `;

  const result = await pool.query(q, [
    id,
    body.fileName,
    body.mimeType ?? null,
    body.fileSize ?? null,
    body.storageKey,
    body.publicUrl ?? publicUrlFor(body.storageKey),
    body.sha256 ?? null,
  ]);

  res.status(200).json({ id: result.rows[0].id });
});

module.exports = router;
