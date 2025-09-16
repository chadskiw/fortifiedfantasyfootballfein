// functions/api/fp-dvp.js
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

const PRO_FIX = { JAC:'JAX', WAS:'WSH', SD:'LAC', OAK:'LV', LA:'LAR' };
const DEFAULT_POS = ['QB','RB','WR','TE','K','D/ST'];

// --- helpers ---
function fixTeam(s='') {
  const up = String(s||'').toUpperCase().replace(/[^A-Z]/g,'');
  return PRO_FIX[up] || up;
}
function canonPos(pos='') {
  const p = String(pos).toUpperCase().replace(/[^A-Z/]/g,'');
  if (p === 'DST' || p === 'DEF' || p === 'D' || p === 'DST/DEF') return 'D/ST';
  if (p === 'PK') return 'K';
  return p;
}
function fpParamPos(pos='') {
  // FantasyPros expects "DST" for defenses; keep others as-is (QB/RB/WR/TE/K)
  return canonPos(pos) === 'D/ST' ? 'DST' : canonPos(pos);
}
function makeKey(team='', pos='') {
  return `${fixTeam(team)}|${canonPos(pos)}`;
}
function readCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  const m = new RegExp('(?:^|;\\s*)'+name+'=([^;]+)').exec(raw);
  return m ? decodeURIComponent(m[1]) : '';
}
function normalizeScoring(s='ppr') {
  const v = String(s).toLowerCase();
  if (v.startsWith('half')) return 'HALF';
  if (v === 'std' || v === 'standard' || v === 'nonppr') return 'STD';
  return 'PPR';
}

export const onRequest = async ({ request, env, waitUntil }) => {
  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method !== 'GET') {
      return json({ ok:false, error:'method_not_allowed' }, 405);
    }

    const season  = Number(url.searchParams.get('season') || new Date().getUTCFullYear());
    const week    = Number(url.searchParams.get('week') || 1);
    const scoring = normalizeScoring(url.searchParams.get('scoring') || 'ppr');

    // positions param (optional, defaults to all)
    const positions = String(url.searchParams.get('positions') || '')
      .split(/[,\s]+/)
      .map(canonPos)
      .filter(Boolean);
    const POS = positions.length ? positions : DEFAULT_POS;

    // API key (env, header, or cookie)
    const keyHeader = request.headers.get('x-fp-key') || '';
    const keyCookie = readCookie(request, 'fp_key') || '';
    const apiKey    = (env && env.FANTASYPROS_API_KEY) || keyHeader || keyCookie;
    if (!apiKey) {
      return json({
        ok:false,
        error:'missing_key',
        hint:'Provide FantasyPros API key via env.FANTASYPROS_API_KEY, x-fp-key header, or fp_key cookie.'
      }, 401);
    }

    // FantasyPros DvP base — adjust if your validated host differs
    // (Keep in sync with whatever host you used for consensus ranks.)
    const base = `https://api.fantasypros.com/public/v2/json/nfl/${season}/defense-vs-position`;

    async function fetchPos(posCanon) {
      const q = new URLSearchParams({
        position: fpParamPos(posCanon), // e.g., 'DST' for defenses
        scoring,
        week: String(week)
      });
      const req = new Request(`${base}?${q.toString()}`, {
        headers: { 'x-api-key': apiKey, 'accept':'application/json' }
      });

      // Cache ~3h per pos to reduce round-trips
      const cache = caches.default;
      const cacheKey = new Request(req.url, { method:'GET', headers:req.headers });
      let res = await cache.match(cacheKey);
      if (!res) {
        const live = await fetch(req);
        if (!live.ok) return live;
        res = new Response(live.body, live);
        res.headers.set('Cache-Control', 'public, max-age=10800');
        waitUntil(cache.put(cacheKey, res.clone()));
      }
      return res;
    }

    // Build dvpMap: "TEAM|POS" -> numeric rank
    // Lower numbers typically indicate stiffer defenses vs that position.
    const dvpMap = Object.create(null);
    const results = await Promise.allSettled(POS.map(fetchPos));

    for (let i = 0; i < POS.length; i++) {
      const posCanon = POS[i];
      const it = results[i];
      if (it.status !== 'fulfilled' || !it.value || !it.value.ok) continue;

      let j;
      try { j = await it.value.json(); } catch { continue; }

      // Rows commonly appear under { teams }, { data }, or { rows }
      const rows = Array.isArray(j?.teams) ? j.teams
                 : Array.isArray(j?.data)  ? j.data
                 : Array.isArray(j?.rows)  ? j.rows
                 : [];

      for (const row of rows) {
        // Try several common property names seen in FP payloads
        const team = row.team || row.nfl_team || row.abbrev || row.abbreviation ||
                     row.team_abbrev || row.team_abbreviation || '';
        const rank = row.rank_vs_pos || row.rank || row.pos_rank || row.dvp_rank || row.rating || null;

        const n = Number(rank);
        if (!team || !(n > 0)) continue;

        dvpMap[makeKey(team, posCanon)] = n;
      }
    }

    return json({
      ok: true,
      source: 'fantasypros.dvp',
      season,
      week,
      scoring: scoring.toLowerCase(),
      count: Object.keys(dvpMap).length,
      dvpMap
    });
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
};
