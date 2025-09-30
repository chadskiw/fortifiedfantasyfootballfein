// images.routes.js
import express from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { r2, presignPut } from "./r2.js";

const router = express.Router();
const BUCKET = process.env.R2_BUCKET;
const CDN_BASE = process.env.IMG_CDN_BASE || "https://img.fortifiedfantasy.com";

// tiny mime map
const EXT = (ct) => (ct?.includes("webp") ? "webp" :
                     ct?.includes("png")  ? "png"  :
                     ct?.includes("jpeg") || ct?.includes("jpg") ? "jpg" : "bin");

// ------------- presign (used by your primary path) -------------
router.post("/images/presign", express.json({ limit: "32kb" }), async (req, res) => {
  try {
    const { content_type, kind = "misc" } = req.body || {};
    if (!content_type) return res.status(400).json({ ok:false, error:"missing_content_type" });

    const ext = EXT(content_type);
    const key = `${kind}/${nanoid(10)}.${ext}`;
    const url = await presignPut({ bucket: BUCKET, key, contentType: content_type });

    return res.json({ ok: true, url, key, public_url: `${CDN_BASE}/${key}` });
  } catch (e) {
    console.error("presign error:", e);
    return res.status(500).json({ ok:false, error:"presign_failed" });
  }
});

// ------------- direct upload fallback (used when presign fails) -------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 } // accept up to 8MB just in case
});

router.post("/images/upload", upload.single("file"), async (req, res) => {
  try {
    const kind = req.query.kind || "misc";
    if (!req.file) return res.status(400).json({ ok:false, error:"no_file" });

    const contentType = req.file.mimetype || "application/octet-stream";
    const ext = EXT(contentType);
    const key = `${kind}/${nanoid(10)}.${ext}`;

    // put to R2
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: contentType
    }));

    return res.json({ ok:true, key, public_url: `${CDN_BASE}/${key}` });
  } catch (e) {
    console.error("upload fallback error:", e);
    return res.status(500).json({ ok:false, error:"upload_failed" });
  }
});

export default router;
