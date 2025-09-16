/* ============================================================================
   Path: functions/api/platforms/sleeper/players.js
   File: players.js
   Project: FEIN · Fortified Fantasy
   Description:
     GET /api/platforms/sleeper/players?slim=1
     - Proxies Sleeper players index; returns a slimmed object when slim=1.
   ============================================================================ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
const upstreamFail = (m) => json({ ok:false, error:m }, 502);

export const onRequestGet = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const slim = String(url.searchParams.get("slim") || "1") === "1";

    const r = await fetch(`https://api.sleeper.app/v1/players/nfl`);
    if (!r.ok) throw new Error(`Sleeper players ${r.status}`);
    const j = await r.json();

    if (!slim) return json(j);

    // Slim down to essentials
    const out = {};
    for (const [pid, p] of Object.entries(j)) {
      const name =
        p.full_name ||
        (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : (p.last_name || p.first_name || ''));
      out[pid] = {
        id: pid,
        name,
        full_name: p.full_name || null,
        position: p.position || '',
        team: p.team || '',
        headshot: p.headshot || null
      };
    }
    return json({ ok:true, players: out });
  } catch (e) {
    return upstreamFail(String(e?.message || e));
  }
};
