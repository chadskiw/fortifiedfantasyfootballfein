// GET /api/platforms/:platform/players/search?q=achane
// => { ok, platform, q, hits: [{ platform, id, name, team, position, headshot }] }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function badRequest(msg){ return json({ ok:false, error:msg }, 400); }
function upstreamFail(msg){ return json({ ok:false, error:msg }, 502); }

function espnHeadshot(id){
  return `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`;
}

/* ---- ESPN thin search (you can replace with your FP index) ---- */
async function espnSearch(q) {
  const u = `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(q)}&limit=20`;
  const r = await fetch(u, { headers: { "cache-control":"no-cache" }});
  if (!r.ok) throw new Error(`ESPN search ${r.status}`);
  const j = await r.json();
  const hits = [];
  (j?.results || []).forEach(g => (g.items || []).forEach(it => {
    if (it.type !== "player") return;
    const id = Number(it.id);
    hits.push({
      platform: "espn",
      id, // numeric ESPN id
      name: it.name || it.displayName,
      team: it.teamAbbreviation || null,
      position: it.position || null,
      headshot: espnHeadshot(id),
    });
  }));
  return hits;
}

/* ---- Sleeper search (full dump filtered client-side) ---- */
async function sleeperSearch(q) {
  const r = await fetch(`https://api.sleeper.app/v1/players/nfl`);
  if (!r.ok) throw new Error(`Sleeper players ${r.status}`);
  const dict = await r.json();
  const needle = q.toLowerCase();
  const hits = [];
  for (const [rawId, p] of Object.entries(dict)) {
    const name = (p.full_name || `${p.first_name||""} ${p.last_name||""}`.trim()).trim();
    if (!name) continue;
    const hay = [name, p.last_name, p.first_name, p.search_full_name].filter(Boolean).join(" ").toLowerCase();
    if (hay.includes(needle)) {
      hits.push({
        platform: "sleeper",
        id: String(rawId), // sleeper id as string
        name,
        team: p.team || null,
        position: (p.fantasy_positions && p.fantasy_positions[0]) || p.position || null,
        headshot: p.headshot || null,
      });
      if (hits.length >= 25) break;
    }
  }
  return hits;
}

export const onRequestGet = async ({ request, params }) => {
  const url = new URL(request.url);
  const platform = String(params?.platform || "").toLowerCase();
  const q = (url.searchParams.get("q") || "").trim();
  if (!platform) return badRequest("platform required");
  if (!q) return badRequest("q required");

  try {
    switch (platform) {
      case "espn":    return json({ ok:true, platform, q, hits: await espnSearch(q) });
      case "sleeper": return json({ ok:true, platform, q, hits: await sleeperSearch(q) });
      default:        return badRequest(`Unsupported platform: ${platform}`);
    }
  } catch (e) {
    return upstreamFail(String(e));
  }
};
