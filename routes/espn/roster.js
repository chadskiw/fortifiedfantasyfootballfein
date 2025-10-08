// routes/espn/roster.js
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./espnCred'); // <-- NEW

// ----- ESPN → FF maps (corrected) -----
const TEAM_ABBR = {
  1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',
  10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',
  18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',
  26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU'
};

// ESPN defaultPositionId -> canonical position  (✔ fixed)
const POS = {
  1:'QB',
  2:'RB',
  3:'WR',
  4:'TE',
  5:'K',
  16:'DST'
};

// ESPN lineupSlotId -> slot label (expanded)
const SLOT = {
  0:'QB',
  2:'RB',
  3:'RB/WR',
  4:'WR',
  5:'WR/TE',
  6:'TE',
  7:'OP',           // superflex/OP
  16:'DST',
  17:'K',
  18:'P',           // punter in some leagues
  19:'HC',
  20:'BE',
  21:'IR',
  22:'ES',          // espn 'extra slot'
  23:'FLEX',        // RB/WR/TE
  24:'ED',
  25:'DL',
  26:'LB',
  27:'DB',
  28:'DP'
};

// --- helper: pull SWID/S2 from req (cookies or headers) ---
function readEspnCreds(req) {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid =
    c.SWID || c.swid || c.ff_espn_swid ||
    h['x-espn-swid'] || h['x-espn-s2-swid'] || null;
  const s2 =
    c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 ||
    h['x-espn-s2'] || null;
  return { swid, s2 };
}

async function fetchJsonWithCred(url, cand) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'ff-platform-service/1.0',
  };
  if (cand?.swid && cand?.s2) {
    headers['Cookie'] = `espn_s2=${cand.s2}; SWID=${cand.swid}`;
    headers['x-espn-s2'] = cand.s2;
    headers['x-espn-swid'] = cand.swid;
  }
  const r = await fetch(url, { headers });
  const text = await r.text().catch(()=>'');

  return {
    ok: r.ok,
    status: r.status,
    statusText: r.statusText || '',
    json: (!text ? null : (()=>{ try { return JSON.parse(text); } catch { return null; } })()),
    text,
    headers,
  };
}

async function getRosterFromUpstream({ season, leagueId, week, teamId, req, debug }) {
  if (!season || !leagueId) throw new Error('season and leagueId are required');

  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const params = new URLSearchParams({
    matchupPeriodId: String(week || 1),
    scoringPeriodId: String(week || 1),
  });
  params.append('view', 'mTeam');
  params.append('view', 'mRoster');
  params.append('view', 'mSettings');

  const url = `${base}?${params.toString()}`;
  console.log('[roster] fetch:', url);

  // Build candidate list and try each until one authorizes
  const candidates = await resolveEspnCredCandidates({ req, leagueId, teamId });
  if (!candidates.length) console.warn('[espn/roster] no ESPN creds available for league', { leagueId, teamId });

  const errors = [];
  let data = null, winner = null;

  for (const cand of candidates) {
    const res = await fetchJsonWithCred(url, cand);
    if (res.ok && res.json) { data = res.json; winner = cand; break; }

    // Log a compact sample for 401 to help pick the right identity later
    if (res.status === 401) {
      console.warn('[espn/roster] 401 with candidate', {
        leagueId, teamId,
        source: cand.source,
        member_id: cand.member_id || null,
        bodySnippet: (res.text || '').slice(0, 300),
      });
    } else {
      errors.push(`ESPN ${res.status} ${res.statusText}`);
    }
 

  if (!data) {
    // If we tried multiple candidates, include a repro with redacted cookies
    console.warn('[espn/roster] all candidates failed', {
      leagueId, teamId,
      tried: candidates.map(c => c.source),
      lastError: errors[errors.length - 1] || 'unauthorized',
      url,
    });
    // Show curl repro once (cookies redacted)
if (debug) {
  console.warn(
    `[espn/roster] repro: curl -i '${url}' -H 'Accept: application/json, text/plain, */*' ` +
    `-H 'User-Agent: ff-platform-service/1.0' ` +
    `-H 'Cookie: espn_s2=${cand.s2}; SWID=${cand.swid}'`
  );
} else {
  console.warn(
    `[espn/roster] repro: curl -i '${url}' -H 'Accept: application/json, text/plain, */*' ` +
    `-H 'User-Agent: ff-platform-service/1.0' ` +
    `-H 'Cookie: espn_s2=${cand.s2}; SWID=${cand.swid}'`
  );
}}
    throw new Error(errors[0] || 'ESPN 401');
  }

  if (winner) {
    // Optionally expose which source won (useful for front-end debugging)
    try { req.res?.set?.('x-espn-cred-source', winner.source || 'unknown'); } catch {}
  }

  // ---- existing normalization code below unchanged ----
  const teamNameOf = (t) => {
    const loc = t?.location || t?.teamLocation || '';
    const nick = t?.nickname || t?.teamNickname || '';
    const joined = `${loc} ${nick}`.trim();
    return joined || t?.name || `Team ${t?.id}`;
  };

  const rosterEntriesOf = (t) => {
    const entries = t?.roster?.entries || [];
    return entries.map(e => {
      const p = e?.playerPoolEntry?.player || e?.player || {};
      return {
        lineupSlotId: e?.lineupSlotId ?? e?.player?.lineupSlotId,
        onTeam: true,
        player: {
          id: p?.id,
          fullName: p?.fullName || p?.displayName || p?.name,
          defaultPositionId: p?.defaultPositionId,
          proTeamId: p?.proTeamId,
          proTeamAbbreviation: p?.proTeamAbbreviation,
          headshot: p?.headshot || p?.ownership?.profile?.headshot || null,
          image: p?.image || null,
          photo: p?.photo || null,
          avatar: p?.avatar || null,
          fantasyProsId: p?.fantasyProsId || p?.fpId
        }
      };
    });
  };

  if (teamId != null) {
    const team = (data?.teams || []).find(t => Number(t?.id) === Number(teamId));
    if (!team) return { ok: true, team_name: `Team ${teamId}`, players: [] };
    const players = rosterEntriesOf(team);
    return { ok: true, team_name: teamNameOf(team), players };
  }

  const teams = (data?.teams || []).map(t => ({
    teamId: t?.id,
    team_name: teamNameOf(t),
    players: rosterEntriesOf(t)
  }));
  return { ok: true, teams };
}


function resolveHeadshot(p, position, teamAbbr) {
  // Prefer explicit URLs ESPN sometimes returns
  const cand =
    p.headshot?.href ||
    p.headshot ||
    p.image?.href ||
    p.photo?.href ||
    p.avatar?.href ||
    null;

  if (cand) return cand;

  // D/ST: use team logo (players don't have headshots)
  if (position === 'DST' && teamAbbr) {
    const slug = teamAbbr.toLowerCase();
    return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${slug}.png&h=80&w=80&scale=crop`;
  }

  // Fallback to ESPN id-based headshot (often exists)
  if (p.id) {
    return `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`;
  }

  // Final local placeholder
  return '/img/placeholders/player.png';
}

function espnRosterEntryToPlayer(entry = {}) {
  const p = entry.player || entry;

  const teamAbbr =
    p.proTeamAbbreviation ||
    TEAM_ABBR[p.proTeamId] ||
    p.proTeam ||
    '';

  // Position: prefer mapped id, then any string present
  const position =
    POS[p.defaultPositionId] ||
    p.position ||
    p.defaultPosition ||
    (p.player && POS[p.player?.defaultPositionId]) ||
    '';

  // Slot: from lineupSlotId with safe fallbacks
  const slot =
    SLOT[entry.lineupSlotId] ||
    entry.slot ||
    (entry.onTeam ? 'BE' : 'BE');

  const isStarter = !['BE','BN','IR'].includes(String(slot).toUpperCase());

  const fpId =
    p.fantasyProsId ||
    p.fpId ||
    p.externalIds?.fantasyProsId ||
    p.externalIds?.fpid ||
    undefined;

  const headshot = resolveHeadshot(p, position, teamAbbr);

  return {
    id: p.id || p.playerId,
    name: p.fullName || p.displayName || p.name,
    team: teamAbbr,
    position,            // ✔ correct now (TE shows as TE)
    slot,                // QB/RB/WR/TE/FLEX/K/DST/BE/IR/...
    isStarter,
    fpId,
    headshot
  };
}
// Self-test so you can verify the mount works:
router.get('/roster/selftest', (_req, res) => {
  res.json({ ok:true, msg:'roster router mounted' });
});

// Main endpoint used by FE/ingestor
router.get('/roster', async (req, res) => {
  try {
    const season  = Number(req.query.season);
    const leagueId= String(req.query.leagueId || '');
    const week    = Number(req.query.week || 1);
    const teamId  = req.query.teamId ? Number(req.query.teamId) : null;

    const raw = await getRosterFromUpstream({ season, leagueId, week, teamId, req });

    if (teamId != null) {
      const players = (raw.players || []).map(espnRosterEntryToPlayer);
      return res.json({
        ok: true,
        platform: 'espn',
        leagueId, season, week, teamId,
        team_name: raw.team_name || `Team ${teamId}`,
        players
      });
    }

    const teams = (raw.teams || []).map(t => ({
      teamId: t.teamId,
      team_name: t.team_name,
      players: (t.players || []).map(espnRosterEntryToPlayer)
    }));
    return res.json({ ok:true, platform:'espn', leagueId, season, week, teams });
  } catch (err) {
    console.error('[espn/roster] error:', err);
    res.status(500).json({ ok:false, error:String(err?.message || err) });
  }
});


/* ===== Exports (cover CJS + ESM) ===== */
module.exports = router;   
