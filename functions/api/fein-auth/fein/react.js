// functions/api/fein/react.js
// Fortified Fantasy — Universal Reactions (fire/fish/trash)
// - Entity keys: fflteam:s:l:t, fflplayer:pid, nflteam:ABBR, fflleague:s:l
// - POST: { entity_key, type, inc? }   -> records reaction, returns counts
//   * fire: increments (client also rate-limits own team 1/day)
//   * fish/trash: toggle per user (max 1 per user, server-enforced)
// - GET:  ?ekey=...                    -> returns { counts, user }
//   * If cookies (SWID/espn_s2) are present, also returns the user’s toggle state
//
// Storage:
//   - Default: in-memory Map (ephemeral; survives within a single worker instance).
//   - Optional: Cloudflare KV for persistence. Set USE_KV=true and bind REACTS_KV.
//
// Notes:
//   - We don’t try to determine “own team” server-side (requires extra ESPN lookups).
//     Your front-end already limits fire on own team 1/day; server just increments.
//
// ---------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,accept,x-espn-swid,x-espn-s2",
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, ...extra } });

// ---------- Minimal pluggable storage (KV optional) ----------
const USE_KV = false; // set to true if you’ve bound REACTS_KV in wrangler.toml

// In-memory fallback (per instance)
const memCounts = new Map(); // entity_key -> { fire,nFish,nTrash }
const memUsers  = new Map(); // `user|entity_key` -> { fish:true/false, trash:true/false }

const keyCounts = (ekey) => `counts:${ekey}`;
const keyUser   = (uid, ekey) => `user:${uid}|${ekey}`;

async function loadCounts(env, ekey) {
  if (USE_KV && env?.REACTS_KV) {
    const s = await env.REACTS_KV.get(keyCounts(ekey));
    return s ? JSON.parse(s) : { fire:0, fish:0, trash:0 };
  }
  return memCounts.get(ekey) || { fire:0, fish:0, trash:0 };
}
async function saveCounts(env, ekey, counts) {
  const c = { fire: counts.fire|0, fish: counts.fish|0, trash: counts.trash|0 };
  if (USE_KV && env?.REACTS_KV) {
    await env.REACTS_KV.put(keyCounts(ekey), JSON.stringify(c));
  } else {
    memCounts.set(ekey, c);
  }
  return c;
}

async function loadUserState(env, uid, ekey) {
  if (!uid) return { fish:false, trash:false }; // anonymous = no toggles stored
  if (USE_KV && env?.REACTS_KV) {
    const s = await env.REACTS_KV.get(keyUser(uid, ekey));
    return s ? JSON.parse(s) : { fish:false, trash:false };
  }
  return memUsers.get(keyUser(uid, ekey)) || { fish:false, trash:false };
}
async function saveUserState(env, uid, ekey, state) {
  if (!uid) return state;
  const v = { fish:!!state.fish, trash:!!state.trash };
  if (USE_KV && env?.REACTS_KV) {
    await env.REACTS_KV.put(keyUser(uid, ekey), JSON.stringify(v));
  } else {
    memUsers.set(keyUser(uid, ekey), v);
  }
  return v;
}

// ---------- User identity (ESPN cookies/headers) ----------
function readUserId(request) {
  // prefer headers (proxied by your site), then cookies
  const h = request.headers;
  let swid = h.get("x-espn-swid") || "";
  const cookie = h.get("cookie") || "";
  if (!swid) {
    const m = cookie.match(/SWID=([^;]+)/i);
    swid = m ? decodeURIComponent(m[1]) : "";
  }
  // normalize braces
  if (swid && !/^\{.*\}$/.test(swid)) swid = "{" + swid.replace(/^\{|\}$/g, "") + "}";
  // anonymous if missing
  return swid || null;
}

// ---------- Validation ----------
const VALID_TYPES = new Set(["fire","fish","trash"]);
function validateEKey(ekey){
  // quick sanity: must include a colon and have no spaces
  return typeof ekey === "string" && ekey.includes(":") && !/\s/.test(ekey);
}

// ---------- Handlers ----------
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const ekey = u.searchParams.get("ekey");
  if (!validateEKey(ekey)) return json({ ok:false, error:"Invalid or missing ekey" }, 400);

  const uid = readUserId(request);
  const counts = await loadCounts(env, ekey);
  const user   = await loadUserState(env, uid, ekey);

  return json({ ok:true, entity_key: ekey, counts, user, uid: uid ? uid : null });
}

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch {}
  const ekey = String(body?.entity_key || "");
  const type = String(body?.type || "").toLowerCase();
  const inc  = Number(body?.inc || 0);

  if (!validateEKey(ekey)) return json({ ok:false, error:"Invalid or missing entity_key" }, 400);
  if (!VALID_TYPES.has(type)) return json({ ok:false, error:"Invalid type" }, 400);

  const uid = readUserId(request);
  let counts = await loadCounts(env, ekey);

  if (type === "fire") {
    // Always increments (client enforces own-team 1/day visual rule)
    counts.fire = (counts.fire|0) + (Number.isFinite(inc) ? Math.max(0, inc) : 0);
    counts = await saveCounts(env, ekey, counts);
    return json({ ok:true, entity_key: ekey, counts, user:{}, uid: uid ? uid : null });
  }

  // fish / trash — toggle per user (requires a uid; anonymous users treated as stateless togglers)
  let user = await loadUserState(env, uid, ekey);

  if (type === "fish") {
    const had = !!user.fish;
    // Toggle
    if (had) { counts.fish = Math.max(0, (counts.fish|0) - 1); user.fish = false; }
    else     { counts.fish = (counts.fish|0) + 1;              user.fish = true;  }
    counts = await saveCounts(env, ekey, counts);
    user   = await saveUserState(env, uid, ekey, user);
    return json({ ok:true, entity_key: ekey, counts, user, uid: uid ? uid : null });
  }

  if (type === "trash") {
    const had = !!user.trash;
    if (had) { counts.trash = Math.max(0, (counts.trash|0) - 1); user.trash = false; }
    else     { counts.trash = (counts.trash|0) + 1;               user.trash = true;  }
    counts = await saveCounts(env, ekey, counts);
    user   = await saveUserState(env, uid, ekey, user);
    return json({ ok:true, entity_key: ekey, counts, user, uid: uid ? uid : null });
  }

  // unreachable
  return json({ ok:false, error:"Unhandled" }, 400);
}
