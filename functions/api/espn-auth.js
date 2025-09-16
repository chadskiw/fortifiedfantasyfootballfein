// functions/api/espn-auth.js

const DOMAIN = '.fortifiedfantasy.com';                  // apex + subdomains
const MAX_AGE_SEC = 300 * 24 * 60 * 60;                  // ~300 days
const DEFAULT_RETURN = 'https://fortifiedfantasy.com/fein/index.html?season=2025';

// ---- helpers ---------------------------------------------------------------

function normalizeSwid(raw) {
  if (!raw) return raw;
  const t = String(raw).trim();
  if (/^\{[0-9a-f-]{36}\}$/i.test(t)) return t.toUpperCase();
  return `{${t.replace(/^\{|\}$/g, '').toUpperCase()}}`;
}

function safeTarget(to) {
  try {
    const u = new URL(to);
    if (u.hostname.endsWith('fortifiedfantasy.com')) return u.toString();
  } catch {}
  return DEFAULT_RETURN;
}

function appendCookie(headers, name, value, { httpOnly = true } = {}) {
  const parts = [
    `${name}=${value}`,
    `Path=/`,
    `Domain=${DOMAIN}`,
    `Max-Age=${MAX_AGE_SEC}`,
    `Secure`,
    `SameSite=Lax`,
  ];
  if (httpOnly) parts.push('HttpOnly'); // keep SWID/espn_s2 HttpOnly
  headers.append('Set-Cookie', parts.join('; '));
}

function clearCookie(headers, name) {
  headers.append(
    'Set-Cookie',
    `${name}=; Path=/; Domain=${DOMAIN}; Max-Age=0; Secure; SameSite=Lax; HttpOnly`
  );
}

async function fetchJSON(url, init) {
  const r = await fetch(url, init);
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  if (!r.ok) {
    const msg = (j && (j.error || j.message)) || r.statusText;
    throw new Error(`${r.status} ${msg}`);
  }
  return j ?? {};
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve({ ok: false }); }
    );
  });
}

// Pull a decent display name from leagues payloads
function pickUsernameFromLeagues(leagues = []) {
  for (const L of leagues) {
    const members = Array.isArray(L?.members) ? L.members : (Array.isArray(L?.users) ? L.users : []);
    for (const m of members) {
      const name = String(m?.displayName || m?.nickname || m?.userName || '').trim();
      if (name && !name.startsWith('{')) return name;
    }
  }
  // Try team owners
  for (const L of leagues) {
    const teams = Array.isArray(L?.teams) ? L.teams : [];
    for (const t of teams) {
      const owner = String(t?.owner || t?.ownerName || t?.primaryOwner || '').trim();
      if (owner && !owner.startsWith('{')) return owner;
    }
  }
  return 'ESPN User';
}

function brace(s) {
  if (!s) return s;
  const t = String(s).trim();
  return t.startsWith('{') ? t : `{${t.replace(/^\{|\}$/g, '')}}`;
}

// Resolve my team for a league from teams[] given SWID + fallback username
function findMyTeamId(leagueObj, userSwid, username) {
  const teams = Array.isArray(leagueObj?.teams) ? leagueObj.teams : [];
  const meBrace = brace(userSwid);
  const meBare  = meBrace?.replace(/^\{|\}$/g, '');

  // exact owner id match (primaryOwner / ownerId)
  for (const t of teams) {
    const oid = String(t?.primaryOwner || t?.ownerId || '').trim();
    if (!oid) continue;
    if (oid === meBrace || oid === meBare) return String(t.teamId ?? t.id ?? '');
  }
  // owner string match
  if (username) {
    for (const t of teams) {
      const owner = String(t?.owner || t?.ownerName || '').trim();
      if (owner && owner.toLowerCase() === username.toLowerCase()) {
        return String(t.teamId ?? t.id ?? '');
      }
    }
  }
  // weak fallback: if exactly one looks like SWID
  const swidish = teams.filter(t => /^\{?[0-9A-F-]{8}/i.test(String(t?.primaryOwner || '')));
  if (swidish.length === 1) return String(swidish[0].teamId ?? swidish[0].id ?? '');
  return '';
}

// Server-side upsert: fetch leagues → teams → upsert each league/team
async function upsertAllBeforeRedirect({ origin, swid, s2, season }) {
  try {
    // 1) leagues
    const leaguesObj = await fetchJSON(`${origin}/api/platforms/espn/leagues?season=${encodeURIComponent(season)}`, {
      method: 'GET',
      headers: {
        'x-espn-swid': swid,
        'x-espn-s2': s2,
      },
      credentials: 'include',
    });
    const leagues = Array.isArray(leaguesObj?.leagues) ? leaguesObj.leagues : [];
    if (!leagues.length) return { ok: true, leagues: 0, upserts: 0 };

    const username = pickUsernameFromLeagues(leagues);

    // 2) per-league teams → resolve mine → upsert
    let upserts = 0;
    for (const L of leagues) {
      const leagueId = String(L?.leagueId ?? L?.id ?? '').trim();
      if (!leagueId) continue;

      const teamsObj = await fetchJSON(`${origin}/api/platforms/espn/teams?season=${encodeURIComponent(season)}&leagueId=${encodeURIComponent(leagueId)}`, {
        method: 'GET',
        headers: {
          'x-espn-swid': swid,
          'x-espn-s2': s2,
        },
        credentials: 'include',
      });
      const leagueShape = { ...L, teams: Array.isArray(teamsObj?.teams) ? teamsObj.teams : [] };
      const myTeamId = findMyTeamId(leagueShape, swid, username);
      if (!myTeamId) continue;

      // upsert
      const r = await fetch(`${origin}/api/fein-auth/fein/meta/upsert`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-espn-swid': swid,
          'x-espn-s2': s2,
        },
        body: JSON.stringify({
          season,
          platform: 'espn',
          league_id: String(leagueId),
          team_id: String(myTeamId),
          // name/handle can be resolved server-side later if needed
        }),
        credentials: 'include',
      });
      if (r.ok) upserts += 1;
    }
    return { ok: true, leagues: leagues.length, upserts };
  } catch (e) {
    // Never block redirect on failure
    return { ok: false, error: e?.message || String(e) };
  }
}

// ----------------------------------------------------------------------------

export async function onRequestGet({ request, env, params, next, data }) {
  const url = new URL(request.url);
  let swid = url.searchParams.get('swid');
  const s2  = url.searchParams.get('s2');
  const to  = url.searchParams.get('to');
  const season = Number(url.searchParams.get('season')) || new Date().getUTCFullYear();

  if (!swid || !s2) {
    return new Response(JSON.stringify({ ok: false, error: 'missing swid/s2' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  swid = normalizeSwid(swid);

  // prepare redirect + cookies
  const headers = new Headers();
  // wipe previous
  clearCookie(headers, 'SWID');
  clearCookie(headers, 'espn_s2');
  headers.append('Set-Cookie', `fein_has_espn=; Path=/; Max-Age=0; Secure; SameSite=Lax`);

  // set fresh cookies — DO NOT mutate s2 (it may contain %2B/%3D etc.)
  appendCookie(headers, 'SWID', swid, { httpOnly: true });
  appendCookie(headers, 'espn_s2', s2, { httpOnly: true });
  // readable flag for client
  headers.append('Set-Cookie', `fein_has_espn=1; Path=/; Domain=${DOMAIN}; Max-Age=${MAX_AGE_SEC}; Secure; SameSite=Lax`);

  // ---- NEW: best-effort server-side upsert before redirect (<=2.5s) -------
  const origin = `${url.protocol}//${url.host}`;
  await withTimeout(
    upsertAllBeforeRedirect({ origin, swid, s2, season }),
    2500
  );

  headers.set('Location', safeTarget(to));
  return new Response(null, { status: 303, headers });
}

export async function onRequestPost({ request }) {
  // kept as your JSON/XHR flow; client can redirect after receiving { ok, to }
  let body = {};
  try { body = await request.json(); } catch {}
  let { swid, s2, to, season } = body || {};
  if (!swid || !s2) {
    return new Response(JSON.stringify({ ok: false, error: 'missing swid/s2' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  swid = normalizeSwid(swid);
  season = Number(season) || new Date().getUTCFullYear();

  const headers = new Headers();
  clearCookie(headers, 'SWID');
  clearCookie(headers, 'espn_s2');
  headers.append('Set-Cookie', `fein_has_espn=; Path=/; Max-Age=0; Secure; SameSite=Lax`);

  appendCookie(headers, 'SWID', swid, { httpOnly: true });
  appendCookie(headers, 'espn_s2', s2, { httpOnly: true });
  headers.append('Set-Cookie', `fein_has_espn=1; Path=/; Domain=${DOMAIN}; Max-Age=${MAX_AGE_SEC}; Secure; SameSite=Lax`);

  // Optional: you can also upsert here best-effort (non-blocking) by kicking and not awaiting.
  // (POST usually powers your in-page modal where you dispatch 'fein:auth:updated'.)
  // void upsertAllBeforeRedirect({ origin: new URL(request.url).origin, swid, s2, season });

  return new Response(JSON.stringify({ ok: true, to: safeTarget(to) }), {
    status: 200,
    headers,
  });
}

export async function onRequestDelete() {
  const headers = new Headers();
  clearCookie(headers, 'SWID');
  clearCookie(headers, 'espn_s2');
  headers.append('Set-Cookie', `fein_has_espn=; Path=/; Max-Age=0; Secure; SameSite=Lax`);
  return new Response(JSON.stringify({ ok: true, cleared: true }), {
    status: 200,
    headers: { ...Object.fromEntries(headers), 'content-type': 'application/json' },
  });
}
