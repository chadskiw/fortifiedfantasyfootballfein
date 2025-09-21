// Proxies /api/identity/* on fortifiedfantasy.com to your Render service
const ALLOW = new Set([
  "https://fortifiedfantasy.com",
  "https://fortifiedfantasyfootball.pages.dev",
  // add any preview URL(s) eg:
  "https://ba535be3.fortifiedfantasyfootball.pages.dev",
]);

function cors(origin) {
  const h = new Headers();
  if (origin && ALLOW.has(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Allow-Credentials", "true");
    h.set("Vary", "Origin");
  }
  h.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key");
  h.set("Access-Control-Max-Age", "600");
  return h;
}

export const onRequestOptions = async ({ request }) =>
  new Response(null, { status: 204, headers: cors(request.headers.get("Origin")) });

export const onRequest = async ({ request }) => {
  const url = new URL(request.url);
  // forward the *exact* path/query to your Render app
  const upstream = "https://fein-auth-service.onrender.com" + url.pathname + url.search;

  const init = {
    method: request.method,
    headers: request.headers, // passes cookies & custom headers
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  };

  const resp = await fetch(upstream, init);

  // Pass Set-Cookie through and echo CORS for XHR
  const h = new Headers(resp.headers);
  const ch = cors(request.headers.get("Origin"));
  ch.forEach((v, k) => h.set(k, v));

  return new Response(resp.body, { status: resp.status, headers: h });
};
