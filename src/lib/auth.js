// functions/lib/auth.js
// DB-over-HTTP -> then fallback to headers/cookies

const AUTH_HOST = (globalThis?.FEIN_AUTH_URL || process.env.FEIN_AUTH_URL || '').trim();

/** read swid/s2 from request headers/cookies/query */
function readAuthFromRequest(request, url) {
  const h = request.headers;
  let swid = h.get('x-espn-swid') || '';
  let s2   = h.get('x-espn-s2')   || '';

  const cookie = h.get('cookie') || '';
  if (!swid) swid = decodeURIComponent((cookie.match(/SWID=([^;]+)/i)?.[1] || ''));
  if (!s2)   s2   = decodeURIComponent((cookie.match(/(?:^|;\s*)espn_s2=([^;]+)/i)?.[1] || ''));

  const u = new URL(url);
  if (!swid) swid = u.searchParams.get('swid') || '';
  if (!s2)   s2   = u.searchParams.get('espn_s2') || '';

  if (swid && !/^\{.*\}$/.test(swid)) swid = '{' + swid.replace(/^\{|\}$/g, '') + '}';
  return { swid, s2 };
}

/**
 * getEspnAuth — DB-over-HTTP first, then request fallback
 * @returns {{ swid: string|null, s2: string|null, source: 'service'|'request'|null }}
 */
export async function getEspnAuth(request, { leagueId, teamId, season }) {
  // 1) try service if configured
  if (AUTH_HOST && leagueId && teamId && season) {
    try {
      const url = `${AUTH_HOST.replace(/\/+$/,'')}/fein-auth?` +
                  new URLSearchParams({ leagueId, teamId, season }).toString();
      const r = await fetch(url, { headers: { 'accept': 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        if (j?.ok && j?.swid && j?.espn_s2) {
          return { swid: j.swid, s2: j.espn_s2, source: 'service' };
        }
      }
    } catch { /* ignore, will fallback */ }
  }

  // 2) fallback to request
  const { swid, s2 } = readAuthFromRequest(request, request.url);
  if (swid && s2) return { swid, s2, source: 'request' };

  return { swid: null, s2: null, source: null };
}
