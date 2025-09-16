export function readCookies(cookieHeader = "") {
  const map = {};
  (cookieHeader || "").split(/;\s*/).forEach(p => {
    if (!p) return;
    const i = p.indexOf("=");
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? "" : decodeURIComponent(p.slice(i + 1));
    map[k] = v;
  });
  return map;
}

export function credsFrom(req) {
  const cookieMap = readCookies(req.headers.get("cookie") || "");
  // also allow overrides via headers if you want (e.g., X-ESPN-SWID / X-ESPN-S2)
  const hdrSWID = req.headers.get("X-ESPN-SWID") || "";
  const hdrS2   = req.headers.get("X-ESPN-S2") || "";

  const SWID = (hdrSWID || cookieMap.SWID || "").trim();
  const s2   = (hdrS2 || cookieMap.espn_s2 || "").trim();

  return { SWID, s2 };
}

export function week14Only(url) {
  const w = Number(url.searchParams.get("week"));
  if (!(w >= 1 && w <= 14)) {
    return [null, new Response("Only weeks 1–14 are supported", { status: 400 })];
  }
  return [w, null];
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
