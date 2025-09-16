// functions/api/my-team.js
// Cookie-auth only. Finds the caller's team by SWID ∈ team.owners,
// then upserts {swid, espn_s2, optional fields} to fein_teams via your auth service.

function teamDisplayName(t) {
  const candidates = [
    t.name,
    `${t.location ?? ''} ${t.nickname ?? ''}`,
    t.teamName, t.teamNickname, t.nickname, t.location, t.abbrev
  ].map(s => (s ?? '').toString().trim()).filter(Boolean);
  return candidates[0] || `Team ${t.id}`;
}

const json = (obj, status=200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status, headers:{ 'content-type':'application/json; charset=utf-8' }
  });

const braced = v => `{${String(v||'').replace(/[{}]/g,'').toUpperCase()}}`;

export const onRequestGet = async ({ request, env }) => {
  try {
    const u = new URL(request.url);
    const leagueId = u.searchParams.get('leagueId');
    const season   = Number(u.searchParams.get('season') || '2025');
    if (!leagueId) return json({ ok:false, error:'leagueId required' }, 400);

    // --- cookie-only ESPN auth ---
    const cookieHdr = request.headers.get('cookie') || '';
    const SWIDraw = /(?:^|;\s*)SWID=([^;]+)/i.exec(cookieHdr)?.[1];
    const S2raw   = /(?:^|;\s*)(?:espn_s2|ESPN_S2|s2)=([^;]+)/i.exec(cookieHdr)?.[1];
    if (!SWIDraw || !S2raw) {
      return json({ ok:false, error:'Not linked. SWID/espn_s2 cookies missing on this domain.' }, 401);
    }
    const swid = braced(decodeURIComponent(SWIDraw).trim());
    const s2   = decodeURIComponent(S2raw).trim();

    const headers = {
      cookie: `SWID=${swid}; espn_s2=${s2}`,
      'user-agent': 'Mozilla/5.0 FortifiedFantasy',
      accept: 'application/json, text/plain, */*',
      referer: 'https://fantasy.espn.com/',
      origin: 'https://fantasy.espn.com',
      'x-fantasy-platform': 'kona-PROD',
      'x-fantasy-source': 'kona',
      'x-fantasy-filter': '{}'
    };

    // Pull teams (owners[]), members (display names), and settings (league size/name)
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam&view=mMembers&view=mSettings`;
    const r = await fetch(url, { headers, redirect: 'manual' });
    const txt = await r.text();
    let data; try { data = JSON.parse(txt); } catch {}

    if (!r.ok || !data) {
      return json({ ok:false, error:`ESPN ${r.status}`, snippet: txt.slice(0,180) }, 502);
    }

    const teams   = Array.isArray(data?.teams)   ? data.teams   : [];
    const members = Array.isArray(data?.members) ? data.members : [];
    const memberById = new Map(members.map(m => [braced(m.id), m]));

    // Find my team by SWID in owners[]
    const meSWID = swid;
    const mine = teams.find(t => Array.isArray(t.owners) && t.owners.map(braced).includes(meSWID));
    if (!mine) return json({ ok:false, error:'Could not find a team for this SWID in the league.' }, 404);

    const teamId = Number(mine.id);
    const teamName = teamDisplayName(mine);
    const ownerId   = braced(mine.primaryOwner || mine.owners?.[0]);
    const ownerName = memberById.get(ownerId)?.displayName || null;
    const leagueName = data?.settings?.name || data?.metadata?.name || `League ${leagueId}`;
    const leagueSize = Number(data?.settings?.size || teams.length || 0) || null;

    // ---- FEIN: upsert to fein_teams (only for this page) ----
    // We prefer putting ownerName as "handle" and teamName as "name".
// functions/api/my-team.js (only the upsert call changed; rest of your file same)
    // ---- FEIN: upsert to fein_meta (server -> server) ----
    const AUTH_HOST = (env?.FEIN_AUTH_URL || '').toString().trim();
    const AUTH_KEY  = (env?.FEIN_AUTH_KEY || '').toString().trim();

    if (AUTH_HOST) {
      try {
        const up = await fetch(`${AUTH_HOST.replace(/\/+$/,'')}/fein-auth/upsert-meta`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(AUTH_KEY ? { 'x-fein-key': AUTH_KEY } : {})
          },
          body: JSON.stringify({
            season: String(season),        // server trusted
            platformCode: '018',           // ESPN
            leagueId: String(leagueId),    // server trusted
            teamId: String(teamId),        // server trusted
            swid,
            espn_s2: s2,
            name: teamName,
            handle: ownerName || null,     // capture handle from the beginning
            league_size: leagueSize,
            fb_groups: []                  // initialize as empty array
          })
        });
        await up.json().catch(()=>null); // best-effort
      } catch {
        // swallow errors
      }
    }

    return json({
      ok: true,
      leagueId: Number(leagueId),
      leagueName,
      season,
      teamId,
      teamName,
      ownerName,
      handle: ownerName,                   // include handle in response
      fb_groups: [],                       // include groups from the beginning
      logoUrl: mine.logo || mine.logoUrl || null,
      stored: Boolean(AUTH_HOST)
    });


  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
};
