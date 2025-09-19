// server/r2.js
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export async function createAvatarUpload({ memberId, ext = "webp" }) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const version = 1;

  // Client will send a hash; if not, make a random token
  const token = crypto.randomBytes(16).toString("hex");
  const key = `thumbs/${yyyy}/${mm}/${memberId}/v${version}/${token}.${ext}`;

  const cmd = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,       // "ff-media"
    Key: key,
    ContentType: `image/${ext}`,
    CacheControl: "public, max-age=31536000, immutable",
    Metadata: { "member-id": String(memberId) },
  });

  const url = await getSignedUrl(s3, cmd, { expiresIn: 60 }); // 60s
  return { key, url };
}
