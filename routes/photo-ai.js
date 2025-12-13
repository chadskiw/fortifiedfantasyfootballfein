import express from "express";
const router = express.Router();

const TT_AI_URL = process.env.TT_AI_URL;           // e.g. https://tt-ai.YOUR.workers.dev/describe
const TT_AI_TOKEN = process.env.TT_AI_TOKEN;       // same value as wrangler secret
// assumes you already have `pool` (pg) wired in your server
import { pool } from "../db.js";

function vecLiteral(arr) {
  // pgvector accepts '[...]' text
  return `[${arr.map(n => Number(n).toFixed(8)).join(",")}]`;
}

router.post("/photos/:photo_id/ensure", async (req, res) => {
  const { photo_id } = req.params;

  try {
    // 1) pull your photo row (adapt columns!)
    const p = await pool.query(
      `SELECT photo_id, r2_key, public_url
       FROM tt_photo
       WHERE photo_id = $1`,
      [photo_id]
    );
    if (!p.rowCount) return res.status(404).json({ ok: false, error: "photo_not_found" });

    const photo = p.rows[0];

    // 2) call worker (prefer r2_key if you bound R2 to worker)
    const payload = photo.r2_key
      ? { r2_key: photo.r2_key, max_tags: 12 }
      : { image_url: photo.public_url, max_tags: 12 };

    const aiResp = await fetch(TT_AI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${TT_AI_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    const aiJson = await aiResp.json();
    if (!aiResp.ok || !aiJson.ok) {
      return res.status(502).json({ ok: false, error: "ai_failed", detail: aiJson });
    }

    const { caption, tags, embedding, models } = aiJson;

    // 3) upsert into YOUR table name (adapt this!)
    // If your embedding column is vector(384):
    const embText = vecLiteral(embedding);

    await pool.query(
      `INSERT INTO tt_photo_ai (photo_id, caption, tags, embedding, model, updated_at)
       VALUES ($1, $2, $3, ($4)::vector, $5, NOW())
       ON CONFLICT (photo_id) DO UPDATE SET
         caption = EXCLUDED.caption,
         tags = EXCLUDED.tags,
         embedding = EXCLUDED.embedding,
         model = EXCLUDED.model,
         updated_at = NOW()`,
      [photo_id, caption, tags, embText, `${models.embedding}|${models.pooling}`]
    );

    return res.json({ ok: true, photo_id, caption, tags });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "exception" });
  }
});

export default router;
