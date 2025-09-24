// functions/api/[[path]].js
// Proxies /api/* from CF Pages → your Render service
export async function onRequest({ request }) {
  const RENDER_ORIGIN = 'https://fein-auth-service.onrender.com'; // 👈 set this!

  const inUrl = new URL(request.url);
  // Preserve the /api/* subpath after /api
  const backendPath = inUrl.pathname; // e.g. /api/quickhitter/check

  // Build target URL on Render
  const target = new URL(backendPath, RENDER_ORIGIN);
  target.search = inUrl.search;

  // Copy headers, tweak a couple
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('x-forwarded-host', inUrl.host);
  headers.set('x-ff-proxy', 'cf-pages');

  const method = request.method.toUpperCase();
  const init = {
    method,
    headers,
    body: (method === 'GET' || method === 'HEAD') ? undefined : await request.arrayBuffer(),
    redirect: 'follow',
    cf: { cacheTtl: 0, cacheEverything: false }
  };

  try {
    const resp = await fetch(target, init);
    // Mirror status/headers/body to the browser
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers
    });
  } catch (err) {
    // Return a tiny JSON so you can see it from the browser console
    return new Response(JSON.stringify({ ok:false, error:'proxy_failed', message: String(err) }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  }
}
