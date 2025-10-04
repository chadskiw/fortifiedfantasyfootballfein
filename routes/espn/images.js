const express = require('express');
const fetch   = require('node-fetch');
const crypto  = require('crypto');
const images  = require('./images');

const router  = express.Router();


// GET /api/platforms/espn/image/:id   → streams an authenticated mystique image
router.get("/image/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !/^[0-9a-f-]{32,}$/i.test(id)) {
      return res.status(400).json({ ok:false, error:"bad id" });
    }

    // Pull creds from headers (you already CORS-allow x-espn-swid/x-espn-s2)
    const swid = (req.get("x-espn-swid") || req.cookies?.swid || "").trim();
    const s2   = (req.get("x-espn-s2")   || req.cookies?.espn_s2 || "").trim();

    if (!swid || !s2) {
      // Don’t leak: just 401 (client can fall back to default logo)
      return res.status(401).json({ ok:false, error:"missing espn auth" });
    }

    const url = `https://mystique-api.fantasy.espn.com/apis/v1/domains/lm/images/${encodeURIComponent(id)}`;

    const upstream = await fetch(url, {
      headers: {
        "Cookie": `SWID=${swid}; espn_s2=${s2}`,
        // UA helps some ESPNi edges
        "User-Agent": "FortifiedFantasy/1.0 (+https://fortifiedfantasy.com)",
        "Accept": "image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5",
      },
      redirect: "follow",
    });

    if (!upstream.ok) {
      // 404/401 → generic helmet
      res.status(200)
        .set("Cache-Control", "public, max-age=600") // 10m
        .set("Content-Type", "image/svg+xml")
        .send(DEFAULT_SVG);
      return;
    }

    // Pass through content-type & caching
    res.status(200);
    const ct = upstream.headers.get("content-type") || "image/png";
    const et = upstream.headers.get("etag");
    const cc = upstream.headers.get("cache-control") || "public, max-age=3600";

    res.set("Content-Type", ct);
    if (et) res.set("ETag", et);
    res.set("Cache-Control", cc);

    // Stream body
    upstream.body.pipe(res);
  } catch (err) {
    res.status(200)
      .set("Cache-Control", "public, max-age=600")
      .set("Content-Type", "image/svg+xml")
      .send(DEFAULT_SVG);
  }
});

const DEFAULT_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <rect width="120" height="120" rx="18" fill="#0c1120"/>
  <circle cx="60" cy="60" r="40" fill="#1b243b" />
  <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle"
        font-family="system-ui, -apple-system, Segoe UI, Roboto" font-size="28" fill="#9fb2c9">FF</text>
</svg>`.trim();

export default router;
