CHECK THIS OUT
// TRUE_LOCATION: routes/identity-proxy.js
// IN_USE: FALSE
// routes/identity-proxy.js
const express = require('express');
const router = express.Router();

// If you're on Node 18+, global fetch exists. If not, uncomment:
// const fetch = (...a) => import('node-fetch').then(({default:f}) => f(...a));

router.post('/request-code', express.json(), async (req, res) => {
  try {
    // Forward the body to your Render auth service
    const upstream = await fetch('https://fein-auth-service.onrender.com/api/identity/request-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.body),
    });

    const text = await upstream.text();
    // Pass errors straight through
    if (!upstream.ok) {
      return res.status(upstream.status).send(text);
    }

    // Parse JSON so we can grab the code
    let data = {};
    try { data = JSON.parse(text); } catch {}

    const code = data?.interacted_code;
    if (code) {
      // ✅ First-party cookie (lives on fortifiedfantasy.com)
      // - HttpOnly: true (server-only; flip to false if you need JS to read it)
      // - SameSite=Lax: safe for same-site POST + navigation
      // - Domain: omit to scope to the current host; set to .fortifiedfantasy.com if you need across subdomains
      res.setHeader('Set-Cookie', [
        `ff-interacted=${encodeURIComponent(code)}`,
        'Path=/',
        'Secure',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=31536000',
        // 'Domain=.fortifiedfantasy.com', // uncomment if you use subdomains
      ].join('; '));
    }

    // Optionally remove the code from the response if you don't want it returned to the browser:
    // delete data.interacted_code;

    return res.json(data);
  } catch (err) {
    console.error('[identity-proxy] error', err);
    return res.status(502).json({ ok:false, error:'upstream_error' });
  }
});

module.exports = router;
