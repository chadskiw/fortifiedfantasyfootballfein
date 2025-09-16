// functions/api/rank-cache.js
/**
 * KV-backed cache of FantasyPros consensus ranks.
 * Bind a KV namespace in Wrangler as RANK_CACHE.
 *
 * GET  /api/rank-cache?season=2025&week=1&scoring=ppr&type=ECR
 *      -> If missing, auto-build via local /api/fp-ranks and store.
 *
 * POST /api/rank-cache  { season, week, scoring, type }
 *      -> Force rebuild (ignores existing KV), then store & return.
 */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

const DEFAULTS = { scoring: 'ppr', type: 'ECR' };
const TTL_SECONDS = 6 * 60 * 60; // 6 hours

function normalizeScoring(s='ppr') {
  const v = String(s).toLowerCase();
  if (v.startsWith('half')) return 'half';
  if (v === 'std' || v === 'standard' || v === 'nonppr') return 'std';
  return 'ppr';
}

function keyFor(season, week, scoring='ppr', type='ECR') {
  const s = normalizeScoring(scoring);
  const t = String(type || 'ECR').toUpperCase();
  return `rank:${season}:${week}:${s}:${t}`; // e.g., rank:2025:1:ppr:ECR
}

// PATCH: allow passing through x-fp-key and choose POST vs GET
async function buildRankMap(uOrigin, season, week, scoring='ppr', type='ECR', fpKeyHeader='') {
  // Prefer POST to /api/fp-ranks to match your server's expected contract
  const url = new URL('/api/fp-ranks', uOrigin);
  url.searchParams.set('season', String(season));
  url.searchParams.set('week', String(week));
  url.searchParams.set('scoring', scoring);
  url.searchParams.set('type', type);

  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(fpKeyHeader ? { 'x-fp-key': fpKeyHeader } : {})
  };

  // POST body keeps it flexible if your /api/fp-ranks uses body for overrides later
  const res = await fetch(url.toString(), {
    method: 'POST', // PATCH: use POST
    headers,
    body: JSON.stringify({ season, week, scoring, type })
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    const snippet = data && typeof data === 'object' ? JSON.stringify(data).slice(0,200) : String(data).slice(0,200);
    throw new Error(`fp-ranks failed: ${res.status} ${snippet}`);
  }

  return {
    ok: true,
    source: 'RANKS_KV',
    season: Number(season),
    week: Number(week),
    scoring: String(data.scoring || scoring || 'ppr'),
    type: String(type),
    count: Number(data.count || Object.keys(data.rankMap||{}).length || 0),
    rankMap: data.rankMap || {}
  };
}

export const onRequestGet = async ({ request, env }) => {
  try {
    const u = new URL(request.url);
    const season  = Number(u.searchParams.get('season') || new Date().getUTCFullYear());
    const week    = Number(u.searchParams.get('week')   || 1);
    const scoring = normalizeScoring(u.searchParams.get('scoring') || DEFAULTS.scoring);
    const type    = (u.searchParams.get('type') || DEFAULTS.type).toUpperCase();

    const kvKey = keyFor(season, week, scoring, type);

    // PATCH: forward incoming x-fp-key if provided
    const fpKeyHeader = request.headers.get('x-fp-key') || '';

    if (!env?.RANK_CACHE) {
      const built = await buildRankMap(u.origin, season, week, scoring, type, fpKeyHeader); // PATCH
      return json({ ...built, persisted:false, note:'KV not bound; returning live build (not cached).' });
    }

    let cached = await env.RANK_CACHE.get(kvKey, { type: 'json' });
    if (cached && cached.rankMap) {
      return json({ ok:true, source:'RANKS_KV:kv', ...cached, persisted:true });
    }

    const built = await buildRankMap(u.origin, season, week, scoring, type, fpKeyHeader); // PATCH
    await env.RANK_CACHE.put(kvKey, JSON.stringify(built), { expirationTtl: TTL_SECONDS });
    return json({ ...built, source:'RANKS_KV:built', persisted:true });
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
};

export const onRequestPost = async ({ request, env }) => {
  try {
    const u = new URL(request.url);
    const body = await request.json().catch(()=>null) || {};
    const season  = Number(body.season || u.searchParams.get('season') || new Date().getUTCFullYear());
    const week    = Number(body.week   || u.searchParams.get('week')   || 1);
    const scoring = normalizeScoring(body.scoring || u.searchParams.get('scoring') || DEFAULTS.scoring);
    const type    = String(body.type || u.searchParams.get('type') || DEFAULTS.type).toUpperCase();

    const kvKey = keyFor(season, week, scoring, type);

    // PATCH: forward x-fp-key from the call **to the internal build**
    const fpKeyHeader = request.headers.get('x-fp-key') || '';

    const built = await buildRankMap(u.origin, season, week, scoring, type, fpKeyHeader); // PATCH

    if (env?.RANK_CACHE) {
      await env.RANK_CACHE.put(kvKey, JSON.stringify(built), { expirationTtl: TTL_SECONDS });
      return json({ ...built, source:'RANKS_KV:rebuilt', persisted:true });
    } else {
      return json({ ...built, source:'RANKS_KV:rebuilt', persisted:false, note:'KV not bound; live only.' });
    }
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
};
// /js/rank-cache.js
export function keyOf(p) {
  // Stable key: NAME|TEAM|POS — matches what rank-cache expects/returns
  const name = String(p.name || "").trim().toUpperCase();
  const team = String(p.teamAbbr || p.proTeamAbbr || p.teamAbbreviation || "").trim().toUpperCase();
  const pos  = String(p.position || "").trim().toUpperCase();
  return `${name}|${team}|${pos}`;
}

// Split into batches (rank-cache works better in chunks)
function chunk(arr, n=80) {
  const out = []; for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out;
}

/**
 * Ask /api/rank-cache for enrichment.
 * Input players minimal fields: { name, team, pos }
 * Returns a Map keyed by keyOf(...) with objects like:
 * { ecr, rank, opponent, opponentAbbr, defensiveRank, fmv, eligibleForFMV }
 */
export async function fetchRanksForPlayers(players, { season, week, scoring = "ppr" }) {
  const batches = chunk(players, 80);
  const map = new Map();

  for (const batch of batches) {
    const body = { players: batch.map(p => ({ name: p.name, team: p.team, pos: p.pos })) };
    const url = `/api/rank-cache?season=${encodeURIComponent(season)}&week=${encodeURIComponent(week)}&scoring=${encodeURIComponent(scoring)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });

    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("application/json")) {
      const text = await res.text();
      throw new Error(`rank-cache non-json (${res.status}) ${text.slice(0,200)}`);
    }
    const data = await res.json(); // expected: { ok:true, results:[{ name, team, pos, ... }]}
    const rows = Array.isArray(data?.results) ? data.results : [];
    for (const r of rows) {
      const k = keyOf({ name: r.name, teamAbbr: r.team, position: r.pos });
      map.set(k, r);
    }
  }
  return map;
}

// rank-cache.js
export function rcKey({ name, team, pos }) {
  return `${String(name).trim().toUpperCase()}|${String(team).trim().toUpperCase()}|${String(pos).trim().toUpperCase()}`;
}

export async function fetchRankCache({ season, week, scoring = 'ppr' }, probes) {
  if (!Array.isArray(probes) || !probes.length) return new Map();

  const res = await fetch(
    `/api/rank-cache?season=${encodeURIComponent(season)}&week=${encodeURIComponent(week)}&scoring=${encodeURIComponent(scoring)}`,
    { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ players: probes }) }
  );

  const data = await res.json().catch(() => null);
  const rows = Array.isArray(data?.results) ? data.results : [];

  const map = new Map();
  for (const r of rows) {
    map.set(rcKey({ name: r.name, team: r.team, pos: r.pos }), r);
  }
  return map;
}
