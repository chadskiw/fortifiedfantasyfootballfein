const express = require("express");
const router = express.Router();
const db = require("../src/db/pool"); // <- whatever your pg pool module is

const TT_AI_URL = process.env.TT_AI_URL;     // https://tt-ai.<acct>.workers.dev
const TT_AI_TOKEN = process.env.TT_AI_TOKEN; // same secret as wrangler secret

function toVectorLiteral(arr) {
  // pgvector accepts: [0.1,0.2,...]
  return `[${arr.map(n => Number(n).toFixed(8)).join(",")}]`;
}

// GET /api/trashtalk/search/photos?q=beach%20sunset&party_id=...&limit=20
router.get("/search/photos", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const partyId = req.query.party_id ? String(req.query.party_id) : null;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));

  if (!q) return res.json({ ok: true, results: [] });

  // 1) embed query via Cloudflare Worker /embed
  let embedding;
  try {
    const r = await fetch(`${TT_AI_URL}/embed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${TT_AI_TOKEN}`,
      },
      body: JSON.stringify({ text: q }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j?.error || "embed_failed");
    embedding = j.embedding;
  } catch (e) {
    // fallback: caption text search if worker is down
    const out = await db.query(
      `
      SELECT p.photo_id, p.created_at, p.public_url, ai.caption, ai.tags
      FROM tt_photo p
      JOIN tt_photo_ai ai ON ai.photo_id = p.photo_id AND ai.status = 'ready'
      WHERE ($1::uuid IS NULL OR p.party_id = $1::uuid)
        AND ai.caption ILIKE $2
      ORDER BY p.created_at DESC
      LIMIT $3
      `,
      [partyId, `%${q}%`, limit]
    );
    return res.json({ ok: true, mode: "text", results: out.rows });
  }

  const vec = toVectorLiteral(embedding);

  // 2) vector search in Postgres (scope however you already scope photos)
  const out = await db.query(
    `
    SELECT p.photo_id, p.created_at, p.public_url, ai.caption, ai.tags,
           (ai.embedding <=> $1::vector) AS distance
    FROM tt_photo p
    JOIN tt_photo_ai ai ON ai.photo_id = p.photo_id AND ai.status = 'ready'
    WHERE ($2::uuid IS NULL OR p.party_id = $2::uuid)
    ORDER BY ai.embedding <=> $1::vector
    LIMIT $3
    `,
    [vec, partyId, limit]
  );

  res.json({ ok: true, mode: "semantic", results: out.rows });
});
// GET /api/trashtalk/search/related/:photo_id?party_id=...&limit=20
router.get("/search/related/:photo_id", async (req, res) => {
  const photoId = String(req.params.photo_id);
  const partyId = req.query.party_id ? String(req.query.party_id) : null;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));

  const base = await db.query(
    `SELECT embedding FROM tt_photo_ai WHERE photo_id = $1 AND status = 'ready'`,
    [photoId]
  );
  if (!base.rowCount) return res.json({ ok: true, results: [] });

  const out = await db.query(
    `
    SELECT p.photo_id, p.created_at, p.public_url, ai.caption, ai.tags,
           (ai.embedding <=> (SELECT embedding FROM tt_photo_ai WHERE photo_id = $1)) AS distance
    FROM tt_photo p
    JOIN tt_photo_ai ai ON ai.photo_id = p.photo_id AND ai.status = 'ready'
    WHERE p.photo_id <> $1
      AND ($2::uuid IS NULL OR p.party_id = $2::uuid)
    ORDER BY ai.embedding <=> (SELECT embedding FROM tt_photo_ai WHERE photo_id = $1)
    LIMIT $3
    `,
    [photoId, partyId, limit]
  );

  res.json({ ok: true, results: out.rows });
});

module.exports = router;
