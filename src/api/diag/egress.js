// TRUE_LOCATION: src/api/diag/egress.js
// IN_USE: FALSE
// --- Egress IP diagnostics (what Cloudflare will see for your API token)
app.get(['/api/diag/egress', '/diag/egress'], async (req, res) => {
  res.set('cache-control', 'no-store');
  res.type('application/json');

  // Prefer Node 18+ global fetch; otherwise you can add undici/node-fetch.
  async function ip(url) {
    try { const r = await fetch(url); if (!r.ok) throw new Error(); return (await r.text()).trim(); }
    catch { return null; }
  }

  // Try a couple providers, both v4 and v6
  const [v4a, v4b, v6a, v6b] = await Promise.all([
    ip('https://api.ipify.org'),
    ip('https://ipv4.icanhazip.com'),
    ip('https://api64.ipify.org'),
    ip('https://ipv6.icanhazip.com')
  ]);

  // Basic request introspection (not egress, but handy for debugging)
  const client = {
    cf_connecting_ip: req.get('cf-connecting-ip') || null,
    x_forwarded_for:   req.get('x-forwarded-for') || null,
    remoteAddress:     req.socket?.remoteAddress || null
  };

  res.json({
    ok: true,
    egress_ipv4: v4a || v4b || null,
    egress_ipv6: v6a || v6b || null,
    client
  });
});
