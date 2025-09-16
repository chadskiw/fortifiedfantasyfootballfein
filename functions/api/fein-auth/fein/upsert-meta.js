// functions/api/fein/upsert-meta.js
// POST JSON: { leagueId, teamId, season, teamName?, owner?, leagueSize?, fbName?, fbGroup?, fbHandle? }
// - Soft-fails: never 5xx to the browser; includes upstream status in the response.
// - CORS-friendly and handles OPTIONS preflight.

const API_BASE = ''; // same-origin
function cors(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST,GET,OPTIONS",
    "access-control-allow-headers": "content-type,x-fein-key",
    "cache-control": "no-store",
    ...extra,
  };
}

// CF Pages Function: proxies POSTs to your Render service and forwards SWID/s2
// Path: /api/fein/upsert-meta

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function parseCookies(header = "") {
  const out = {};
  header.split(/; */).forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1));
  });
  return out;
}

function normalizeSwid(v) {
  const s = (v || "").trim();
  if (!s) return "";
  const un = s.replace(/^["']|["']$/g, ""); // strip quotes if any
  if (/^\{.*\}$/.test(un)) return un;
  return `{${un.replace(/^\{|\}$/g, "")}}`;
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const leagueId = u.searchParams.get('leagueId');
  const teamId   = u.searchParams.get('teamId');
  const season   = u.searchParams.get('season');
  if (leagueId && teamId && season) {
    // forward as POST to upstream for convenience
    const AUTH = (env.API_BASE || "https://fein-auth-service.onrender.com").replace(/\/+$/,"");
    const headers = { 'content-type':'application/json', accept:'application/json' };
    if (env.FEIN_AUTH_KEY) headers['x-fein-key'] = env.FEIN_AUTH_KEY;
    const r = await fetch(`${AUTH}/fein/upsert-meta`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ leagueId, teamId, season })
    });
    return new Response(await r.text(), { status: r.status, headers: { 'content-type':'application/json' } });
  }
  return json({ ok:true, hint:'POST JSON here to upsert team meta (and optionally swid/s2)', expect:{ /* … */ } });

}

export async function onRequestPost({ request, env }) {
  try {
 const AUTH = (env.API_BASE || "https://fein-auth-service.onrender.com").replace(/\/+$/,"");
    const KEY  = (env.FEIN_AUTH_KEY || "").trim();

    const body = await request.json().catch(() => ({}));

    // Pull creds from multiple places: body, headers, cookies (HttpOnly is fine server-side)
    const h = request.headers;
    const cookies = parseCookies(h.get("cookie") || "");
    const swidFrom =
      body.swid ||
      h.get("x-espn-swid") ||
      cookies.SWID ||
      cookies.swid ||
      "";
    const s2From =
      body.s2 ||
      h.get("x-espn-s2") ||
      cookies.espn_s2 ||
      cookies.S2 ||
      "";

    const swid = normalizeSwid(swidFrom);
    const s2   = (s2From || "").trim();

    // Forward payload (include swid/s2 only if present)
    const payload = {
      leagueId: body.leagueId,
      teamId: body.teamId,
      season: body.season,
      leagueSize: body.leagueSize ?? body.league_size,
      teamName: body.teamName ?? body.name,
      owner: body.owner ?? body.handle,
      // fb metadata (your Render service merges/dedups)
      fbName: body.fbName,
      fbHandle: body.fbHandle,
      fbGroup: body.fbGroup,
    };
    if (swid) payload.swid = swid;
    if (s2)   payload.s2   = s2;

    // Basic validation before proxying
    if (!payload.leagueId || !payload.teamId || !payload.season) {
      return json({ ok:false, error:"leagueId, teamId, season required" }, 400);
    }

    const headers = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (KEY) headers["x-fein-key"] = KEY;

 const r = await fetch(`${AUTH}/api/fein-auth/upsert-meta`, {   // ✅ no /api prefix
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch {}

    if (!r.ok || j?.ok === false) {
      return json({ ok:false, status:r.status, upstream: j || text.slice(0,300) }, 502);
    }

    return json(j);
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
}
