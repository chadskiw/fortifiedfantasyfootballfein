// /src/routes/platforms/espn/images.js (CommonJS)

const express = require('express');
const { Readable } = require('stream');

const router  = express.Router();

// GET /api/platforms/espn/image/:id → streams an authenticated Mystique image
const path = require('../../public/logo.png');

router.get('/image/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // If id is missing or malformed, just serve the fallback logo
    const looksLikeGuid = id && /^[0-9a-f-]{32,}$/i.test(id);
    if (!looksLikeGuid) {
      res.set('Cache-Control', 'public, max-age=3600');
      return res.sendFile(path.join(process.cwd(), 'public', 'logo.png'));
    }

    // ESPN creds (if you later re-enable upstream)
    const swid = (req.get('x-espn-swid') || req.cookies?.swid || '').trim();
    const s2   = (req.get('x-espn-s2')   || req.cookies?.espn_s2 || '').trim();

    // TEMP: short-circuit to fallback to avoid Mystique flakiness
    res.set('Cache-Control', 'public, max-age=3600');
    return res.sendFile(path.join(process.cwd(), 'public', 'logo.png'));

    /*  ---------- If/when you re-enable Mystique, restore below ----------
    const url = `https://mystique-api.fantasy.espn.com/apis/v1/domains/lm/images/${encodeURIComponent(id)}`;
    if (!swid || !s2) {
      res.set('Cache-Control', 'public, max-age=3600');
      return res.sendFile(path.join(process.cwd(), 'public', 'logo.png'));
    }

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 2500);

    const upstream = await fetch(url, {
      headers: {
        Cookie: `SWID=${swid}; espn_s2=${s2}`,
        'User-Agent': 'FortifiedFantasy/1.0 (+https://fortifiedfantasy.com)',
        Accept: 'image/avif,image/webp,image/png,image/*;q=0.8,*/     /**;q=0.5',
      },
      redirect: 'follow',
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(to);

    const ct = upstream?.headers?.get('content-type') || '';
    if (!upstream?.ok || !/^image\//i.test(ct)) {
      res.set('Cache-Control', 'public, max-age=3600');
      return res.sendFile(path.join(process.cwd(), 'public', 'logo.png'));
    }

    res.set('Content-Type', ct);
    res.set('Cache-Control', upstream.headers.get('cache-control') || 'public, max-age=86400, immutable');

    if (upstream.body) {
      return Readable.fromWeb(upstream.body).pipe(res);
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.end(buf);
    --------------------------------------------------------------------- */
  
  } catch (err) {
    // Absolute safety: always return a valid image response
    res.set('Cache-Control', 'public, max-age=600');
    return res.sendFile(path.join(process.cwd(), 'public', 'logo.png'));
  }
});

const DEFAULT_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <rect width="120" height="120" rx="18" fill="#0c1120"/>
  <circle cx="60" cy="60" r="40" fill="#1b243b" />
  <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle"
        font-family="system-ui, -apple-system, Segoe UI, Roboto" font-size="28" fill="#9fb2c9">FF</text>
</svg>`.trim();

module.exports = router;
