// functions/_lib/http.js
export const THIS_YEAR = new Date().getUTCFullYear();

export function readCookies(cookieHeader = "") {
  const out = {};
  (cookieHeader || "").split(/;\s*/).forEach((p) => {
    if (!p) return;
    const i = p.indexOf("=");
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? "" : decodeURIComponent(p.slice(i + 1));
    out[k] = v;
  });
  return out;
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

export const badRequest   = (msg) => json({ ok:false, error: msg }, 400);
export const unauthorized = (msg) => json({ ok:false, error: msg }, 401);
export const upstreamFail = (msg) => json({ ok:false, error: msg }, 502);
