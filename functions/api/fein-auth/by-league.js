// functions/api/fein-auth/by-league.js
// Fortified Fantasy — FEIN Auth proxy (by-league)
// Tries the canonical Render path first; normalizes output so the UI can rely on
// { ok:true, filters:{...}, count, leagues:[] }.

const API_BASE = '';
const PRIMARY_PATH = "api/fein-league/by-league";  // <- preferred upstream
const LEGACY_PATH  = "api/fein-auth/by-league";    // <- legacy fallback

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type,accept,x-espn-swid,x-espn-s2",
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, ...extra } });

const joinUrl = (base, path) =>
  `${String(base).replace(/\/+$/,'')}/${String(path).replace(/^\/+/, '')}`;

const buildUrl = (base, path, params) => {
  const u = new URL(joinUrl(base, path));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }
  if (!u.searchParams.has("_")) u.searchParams.set("_", Date.now().toString());
  return u.toString();
};

function normalize(payload, filters){
  // Preferred shape: { ok:true, filters:{...}, count, leagues:[...] }
  if (payload && Array.isArray(payload.leagues)) {
    const count = Number.isFinite(payload.count) ? payload.count : payload.leagues.length;
    return { ok:true, filters: payload.filters ?? filters, count, leagues: payload.leagues };
  }
  // Some upstreams may return other keys; treat as empty but keep count sane.
  const count = Number(payload?.count ?? 0) || 0;
  return { ok:true, filters, count, leagues: [] };
}

export async function onRequestOptions(){ return new Response(null, { status:204, headers:CORS }); }

export async function onRequestGet({ request }){
  try{
    const url = new URL(request.url);
    const season   = url.searchParams.get("season");
    const size     = url.searchParams.get("size");
    const leagueId = url.searchParams.get("leagueId") || null;
    const cacheB   = url.searchParams.get("_");

    const filters = {
      season: season ? Number(season) : undefined,
      leagueId: leagueId ? String(leagueId) : null,
      size: size ? Number(size) : undefined,
    };

    const headers = { accept: "application/json" };
    const tryFetch = async (path) => {
      const target = buildUrl(API_BASE, path, { season, size, leagueId, _: cacheB });
      const res = await fetch(target, { headers, signal: (AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined) });
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch {}
      return { ok: res.ok && !!data, status: res.status, data, source: path };
    };

    // Try primary, then legacy
    let out = await tryFetch(PRIMARY_PATH);
    if (!out.ok) out = await tryFetch(LEGACY_PATH);

    if (out.ok) {
      return json(normalize(out.data, filters), 200, { "x-ff-source": `proxy-render:${out.source}` });
    }
    return json(normalize({ count:0, leagues:[] }, filters), 200, { "x-ff-source": "proxy-fallback" });

  } catch (err) {
    return json({ ok:true, filters:{}, count:0, leagues:[], error:String(err?.message||err) }, 200, { "x-ff-source":"proxy-error" });
  }
}
