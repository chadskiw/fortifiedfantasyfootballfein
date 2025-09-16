// functions/api/reactions.js
// Fortified Fantasy — Reaction API
// Allows recording + fetching emoji reactions for players

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,accept",
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: CORS });

// Simple in-memory store (replace with Redis/DB later)
const store = new Map();

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const pid = u.searchParams.get("playerId");
  if (!pid) return json({ ok: false, error: "playerId required" }, 400);
  const recs = store.get(pid) || {};
  return json({ ok: true, playerId: pid, reactions: recs });
}

export async function onRequestPost({ request }) {
  try {
    const { playerId, reaction } = await request.json();
    if (!playerId || !reaction) {
      return json({ ok: false, error: "playerId + reaction required" }, 400);
    }
    const recs = store.get(playerId) || {};
    recs[reaction] = (recs[reaction] || 0) + 1;
    store.set(playerId, recs);
    return json({ ok: true, playerId, reactions: recs });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}
