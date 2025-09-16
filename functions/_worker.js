// functions/_worker.js (or a standalone Worker)
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env));
  },
  async fetch(req, env) {
    // expose a tiny read API: /api/rank-cache?season=2025&week=1
    const u = new URL(req.url);
    if (u.pathname === '/api/fp-ranks') {
      const season = u.searchParams.get('season') || new Date().getUTCFullYear();
      const week   = u.searchParams.get('week') || '1';
      const key    = cacheKey(season, week);
      const json   = await env.RANKS_KV.get(key, 'json');
      return new Response(JSON.stringify(json || { ok:false, count:0, rankMap:{} }), {
        headers: { 'content-type':'application/json; charset=utf-8' }
      });
    }
    return new Response('ok');
  }
};

const FP_BASE = 'https://api.fantasypros.com/public/v2/json';

const FIX = { JAC:'JAX', WAS:'WSH', SD:'LAC', OAK:'LV', LA:'LAR' };
const fixAbbr = s => FIX[String(s||'').toUpperCase()] || String(s||'').toUpperCase();
const tightPos = s => String(s||'').toUpperCase().replace(/[^A-Z]/g,''); // D/ST -> DST
const normName = s => String(s||'')
  .replace(/\b(jr|sr|ii|iii|iv|v)\.?$/i,'')
  .replace(/[^a-z\s]/gi,' ')
  .replace(/\s+/g,' ')
  .trim()
  .toUpperCase();
const keyOf = (name, team, pos) => `${normName(name)}|${fixAbbr(team)}|${tightPos(pos)}`;
const cacheKey = (season, week) => `fp:${season}:${week}`;

async function refreshAll(env) {
  const season = new Date().getUTCFullYear();
  // Weeks 1–18; tweak as needed
  const weeksToFetch = Array.from({length: 18}, (_,i)=> i+1);

  await Promise.all(weeksToFetch.map(w => refreshWeek(env, season, w)));
}

async function refreshWeek(env, season, week) {
  const apiKey = env.FANTASYPROS_API_KEY;
  if (!apiKey) return;

  const url = `${FP_BASE}/nfl/${season}/rankings?week=${week}&scoring=PPR&type=consensus`;
  const res = await fetch(url, { headers: { 'x-api-key': apiKey, accept: 'application/json' }});
  if (!res.ok) return;

  const data = await res.json().catch(()=>null);
  const players = Array.isArray(data?.players) ? data.players : [];
  const rankMap = {};

  for (const r of players) {
    const rank = Number(r.pos_rank || r.rank_ecr || r.rank);
    if (!Number.isFinite(rank) || rank <= 0) continue;
    const name = r.player_name;
    const team = r.player_team_id;
    const pos  = r.position; // FP uses DST for defenses
    const k = keyOf(name, team, pos);
    if (rankMap[k] == null || rank < rankMap[k]) rankMap[k] = rank;
  }

  const payload = { ok:true, source:'fantasypros.rankings', season, week, scoring:'ppr', count:Object.keys(rankMap).length, rankMap };
  await env.RANKS_KV.put(cacheKey(season, week), JSON.stringify(payload), { expirationTtl: 60*60*26 }); // ~26h
}
