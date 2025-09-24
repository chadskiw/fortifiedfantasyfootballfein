// TRUE_LOCATION: functions/api/[[path]].js
// IN_USE: TRUE

// Proxy ALL /api/* calls from fortifiedfantasy.com to the Render Express app.
// Keeps method, headers, body, and query string intact.
// Also handles OPTIONS preflight locally to avoid 405s at the edge.

const RENDER_BASE = 'https://fein-auth-service.onrender.com'; // <-- set to your Render service base (no trailing slash)

export async function onRequest(context) {
  const { request } = context;
  const inUrl = new URL(request.url);

  // Handle preflight at the edge so browsers never see 405 on OPTIONS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  // Strip the leading /api, then re-append it to target (so /api/identity/... -> /api/identity/...)
  const stripped = inUrl.pathname.replace(/^\/api(\/?)/, '$1'); // '/identity/...'
  const targetUrl = new URL('/api' + stripped + inUrl.search, RENDER_BASE);

  // Build a new Request that reuses the original method/headers/body
  const outbound = new Request(targetUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: ['GET','HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
    duplex: 'half' // helps streaming body in some runtimes
  });

  // Forward the request to Render
  const upstream = await fetch(outbound);

  // Mirror upstream response and add permissive CORS so your front-end can read it
  const resHeaders = new Headers(upstream.headers);
  applyCors(resHeaders, request);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  });
}

function corsHeaders(req) {
  const h = new Headers();
  applyCors(h, req);
  return h;
}

function applyCors(h, req) {
  const origin = req.headers.get('Origin') || '*';
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Vary', 'Origin');
  h.set('Access-Control-Allow-Credentials', 'true');
  h.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', req.headers.get('Access-Control-Request-Headers') || 'Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key');
}
