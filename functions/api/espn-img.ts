// functions/api/espn-img.ts
// Proxies ESPN team logo URLs (mystique/cms) so the browser never hits ESPN directly.
// Usage from the page: <img src="/api/espn-img?u=<encoded ESPN URL>" ...>

const ALLOW_HOSTS = new Set([
  "mystique-api.fantasy.espn.com",
  "gerrit-api.fantasy.espn.com",   // sometimes images come from this family too
  "a.espncdn.com",                 // public CDN (cookies not needed)
  "a1.espncdn.com",
  "g.espncdn.com",
]);

function bad(body: any, status = 400) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function readEspnAuth(req: Request, urlStr: string) {
  const url = new URL(urlStr);
  const h = req.headers;

  // headers (case-insensitive)
  let swid = h.get("X-ESPN-SWID") || h.get("x-espn-swid") || "";
  let s2   = h.get("X-ESPN-S2")   || h.get("x-espn-s2")   || "";

  // cookies
  const cookie = h.get("cookie") || "";
  if (!swid) swid = /(?:^|;\s*)SWID=([^;]+)/i.exec(cookie)?.[1] || "";
  if (!s2)   s2   = /(?:^|;\s*)espn_s2=([^;]+)/i.exec(cookie)?.[1] || "";

  // query fallbacks
  if (!swid) swid = url.searchParams.get("swid") || "";
  if (!s2)   s2   = url.searchParams.get("s2") || url.searchParams.get("espn_s2") || "";

  // normalize SWID to {...}
  if (swid && !/^\{.*\}$/.test(swid)) swid = "{" + swid.replace(/^\{|\}$/g, "") + "}";

  return { swid, s2 };
}

export const onRequestGet: PagesFunction = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const raw = url.searchParams.get("u");
    if (!raw) return bad({ error: "Missing ?u=<encoded ESPN image url>" }, 400);

    let tgt: URL;
    try { tgt = new URL(raw); } catch { return bad({ error: "Invalid URL in u" }, 400); }

    if (tgt.protocol !== "https:" || !ALLOW_HOSTS.has(tgt.hostname)) {
      return bad({ error: "Host not allowed", host: tgt.hostname }, 403);
    }

    const { swid, s2 } = readEspnAuth(request, request.url);

    const headers: Record<string, string> = {
      "accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "user-agent": "FortifiedFantasy/1.0 (+cf-pages)",
      "referer": "https://fantasy.espn.com/",
    };
    // mystique often needs cookies; CDN hosts don't
    if (tgt.hostname.includes("mystique") && swid && s2) {
      headers["cookie"] = `espn_s2=${s2}; SWID=${swid}`;
    }

    const r = await fetch(tgt.toString(), {
      headers,
      redirect: "follow",
      cf: { cacheTtl: 3600, cacheEverything: false },
    });

    if (!r.ok) {
      // Fallback to a generic NFL shield on public CDN
      const fallback = "https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/nfl.png&w=40&h=40";
      return Response.redirect(fallback, 302);
    }

    // Stream image through with permissive CORS and caching.
    const ct = r.headers.get("content-type") || "image/png";
    return new Response(r.body, {
      status: 200,
      headers: {
        "content-type": ct,
        "cache-control": "public, max-age=86400, immutable",
        "access-control-allow-origin": "*",
        "x-ff-proxy": "espn-img",
      },
    });
  } catch (e: any) {
    return bad({ error: String(e?.message || e) }, 500);
  }
};
