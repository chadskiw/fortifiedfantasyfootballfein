// functions/api/identity/[[path]].ts (or .js)
export const onRequest: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);
  const upstream = new URL(`https://fein-auth-service.onrender.com${url.pathname}${url.search}`);

  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    body: ["GET","HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  };

  const resp = await fetch(upstream, init);

  // pass cookies/cors through
  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", "https://fortifiedfantasy.com");
  headers.set("Access-Control-Allow-Credentials", "true");

  return new Response(resp.body, { status: resp.status, headers });
};

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "https://fortifiedfantasy.com",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key",
      "Access-Control-Max-Age": "600",
    },
  });
