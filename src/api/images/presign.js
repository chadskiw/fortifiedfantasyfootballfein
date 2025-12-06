// /api/images/presign
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_KEY, secretAccessKey: process.env.R2_SECRET }
});

app.post('/api/images/presign', async (req, res) => {
  const { content_type } = req.body || {};
  const key = `avatars/${Date.now()}-${crypto.randomUUID()}`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, ContentType: content_type }),
    { expiresIn: 60 }
  );
  res.json({ ok: true, type: 'put', url, key, public_url: `https://img.fortifiedfantasy.com/avatars/anon/${key}` });
});
