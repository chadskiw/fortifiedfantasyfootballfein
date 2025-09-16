// functions/api/player.js
// GET /api/player?season=2025&playerId=4426348[&leagueId=...][&swid=...&s2=...][&debug=1]
// SWID/espn_s2 may be provided via headers (x-espn-swid/x-espn-s2) OR query params.

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

const WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);
const POS_BY_ID = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K" };
const PROTEAM_BY_ID = {
  1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',
  9:'GB',10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',
  17:'NE',18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',
  25:'SF',26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU'
};
const ABBR_FIX = { JAC: "JAX", WAS: "WSH", OAK: "LV", SD: "LAC", LA: "LAR" };
const normAbbr = s => ABBR_FIX[String(s||"").toUpperCase()] || String(s||"").toUpperCase();
const ensureBraces = s => s ? `{${String(s).replace(/^\{|\}$/g,'')}}` : '';

async function espnFetch(url, { cookie = "", filterObj = null } = {}) {
  const headers = {
    accept: "application/json",
    referer: "https://fantasy.espn.com/football/",
    "x-fantasy-platform": "kona-PROD",
    "x-fantasy-source": "kona",
    "user-agent": "Mozilla/5.0 FortifiedFantasy"
  };
  if (cookie) headers.cookie = cookie;
  if (filterObj) headers["x-fantasy-filter"] = JSON.stringify(filterObj);

  const r = await fetch(url, { headers, redirect: "follow", cache: "no-store" });
  let data = null, text = "";
  try { data = await r.json(); } catch { try { text = await r.text(); } catch {} }
  return { ok: r.ok, status: r.status, data, text };
}

function extract(container, playerId) {
  const players = Array.isArray(container?.players) ? container.players : [];
  if (!players.length) return null;
  const rec = players.find(x => String(x?.id) === String(playerId)) || players[0];
  const player = rec?.player || rec || {};
  const stats  = Array.isArray(rec?.player?.stats) ? rec.player.stats
             : Array.isArray(rec?.stats)        ? rec.stats
             : Array.isArray(player?.stats)      ? player.stats
             : [];
  return { player, stats };
}

function weeksFromStats(stats = []) {
  const actualByWeek = {};
  for (const s of stats) {
    const w = s?.scoringPeriodId;
    if (w && Number.isFinite(s?.appliedTotal)) actualByWeek[w] = s.appliedTotal;
  }
  return WEEKS.map(week => ({
    week, proj: undefined, fmv: undefined,
    actual: actualByWeek[week], opp: undefined, dvp: undefined
  }));
}

function teamAbbrFrom(p) {
  const a = p?.proTeamAbbreviation || p?.proTeam || "";
  if (a) return normAbbr(a);
  const id = Number(p?.proTeamId);
  return PROTEAM_BY_ID[id] || "";
}

export const onRequestGet = async ({ request }) => {
  const u = new URL(request.url);
  const debug = u.searchParams.get("debug") === "1";

  const dbg = { step: "start" };
  try {
    const season   = Number(u.searchParams.get("season"));
    const playerId = String(u.searchParams.get("playerId") || "").trim();
    const leagueId = u.searchParams.get("leagueId") || ""; // optional now

    if (!season || !playerId) {
      return json({ error: "season and playerId required", hint: "leagueId optional" }, 400);
    }

    // --- Auth: headers first, then query params (so you can test from the location bar)
    let swid = (request.headers.get("x-espn-swid") || "").trim();
    let s2   = (request.headers.get("x-espn-s2")   || "").trim();
    const qsSwid = u.searchParams.get("swid") || "";
    const qsS2   = u.searchParams.get("s2")   || "";

    try { if (!swid && qsSwid) swid = decodeURIComponent(qsSwid); } catch {}
    try { if (!s2   && qsS2)   s2   = decodeURIComponent(qsS2);   } catch {}
    if (swid) swid = ensureBraces(swid);

    const cookie = (swid && s2) ? `SWID=${swid}; espn_s2=${s2}` : "";
    dbg.auth = { swid: !!swid, s2: !!s2 };

    // Robust single-player filter
    const filter = {
      players: {
        filterIds: { value: [ Number(playerId) ] },
        filterStatus: { value: ["FREEAGENT","ONTEAM","WAIVERS","INJURY_RESERVE","UNKNOWN"] }
      }
    };

    const tries = [];
    let found = null;

    // 1) league-scoped (if leagueId provided)
    if (leagueId) {
      const url1 = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=kona_player_info`;
      const r1 = await espnFetch(url1, { cookie, filterObj: filter });
      tries.push({ kind: "league:kona_player_info", status: r1.status, hasPlayers: Array.isArray(r1.data?.players) ? r1.data.players.length : 0 });
      if (r1.ok && r1.data) {
        const f = extract(r1.data, playerId);
        if (f) found = f;
      }
    }

    // 2) global players (kona_player_info)
    if (!found) {
      const url2 = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players?view=kona_player_info`;
      const r2 = await espnFetch(url2, { cookie, filterObj: filter });
      tries.push({ kind: "players:kona_player_info", status: r2.status, hasPlayers: Array.isArray(r2.data?.players) ? r2.data.players.length : 0 });
      if (r2.ok && r2.data) {
        const f = extract(r2.data, playerId);
        if (f) found = f;
      }
    }

    // 3) global players (players_wl)
    if (!found) {
      const url3 = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players?view=players_wl`;
      const r3 = await espnFetch(url3, { cookie, filterObj: filter });
      tries.push({ kind: "players:players_wl", status: r3.status, hasPlayers: Array.isArray(r3.data?.players) ? r3.data.players.length : 0 });
      if (r3.ok && r3.data) {
        const f = extract(r3.data, playerId);
        if (f) found = f;
      }
    }

    // 4) last-ditch identity fallback (public site API; no fantasy stats)
    let identity = null;
    if (!found) {
      const siteUrl = `https://site.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${encodeURIComponent(playerId)}`;
      const r4 = await fetch(siteUrl, { headers: { accept: "application/json" } });
      if (r4.ok) {
        const j = await r4.json().catch(()=>null);
        if (j) {
          identity = {
            name: j?.athlete?.displayName || j?.displayName || `Player ${playerId}`,
            position: j?.athlete?.position?.abbreviation || j?.position?.abbreviation || "",
            teamAbbr: normAbbr(j?.athlete?.team?.abbreviation || j?.team?.abbreviation || "")
          };
        }
      }
      tries.push({ kind: "siteapi:athlete", status: r4.status });
    }

    if (!found && !identity) {
      return json({
        ok: true,
        playerId,
        name: `Player ${playerId}`,
        teamAbbr: "",
        position: "",
        weeks: [],
        attempts: debug ? tries : undefined
      });
    }

    const name = found
      ? (found.player?.fullName || found.player?.name || `Player ${playerId}`)
      : identity.name;

    const position = found
      ? (POS_BY_ID[found.player?.defaultPositionId] || found.player?.position || "")
      : identity.position;

    const teamAbbr = found
      ? teamAbbrFrom(found.player)
      : identity.teamAbbr;

    const weeks = found ? weeksFromStats(found.stats) : [];

    const payload = { ok: true, playerId, name, teamAbbr, position, weeks };
    if (debug) payload.attempts = tries;
    return json(payload);
  } catch (e) {
    dbg.err = String(e);
    return json({ error: String(e), dbg: debug ? dbg : undefined }, 500);
  }
};
