// GET /api/fein-auth/creds?leagueId=...&season=YYYY
// Server-side proxy to your Render service so the browser never talks cross-origin.

const RENDER_BASE = 'https://fein-auth-service.onrender.com'; // or env var

function j(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export const onRequestGet = async ({ request }) => {
  try {
    const u = new URL(request.url);
    const leagueId = u.searchParams.get('leagueId');
    const season   = u.searchParams.get('season');

    if (!leagueId) return j({ ok: false, error: 'leagueId is required' }, 400);

    // Build the Render URL (server-to-server)
    const upstream = new URL('/api/fein-auth/creds', RENDER_BASE);
    upstream.searchParams.set('leagueId', leagueId);
    if (season) upstream.searchParams.set('season', season);

    // Fetch from server (no CORS involved here)
    const r = await fetch(upstream.toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
      // no credentials needed; this is server-side
    });

    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep null */ }

    if (!r.ok) {
      return j({ ok: false, status: r.status, error: body?.error || text || 'Upstream error' }, 502);
    }

    // Pass through the JSON as-is (or prune if needed)
    return j({ ok: true, ...body }, 200, {
      // cache lightly if desired:
      'cache-control': 'private, max-age=60',
    });
  } catch (e) {
    return j({ ok: false, error: String(e?.message || e) }, 500);
  }
};

// Optional: POST support (mirror GET behavior for future use)
export const onRequestPost = onRequestGet;
