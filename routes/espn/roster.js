// routes/espn/roster.js
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');
const { fetchJsonWithCred } = require('./_fetch');

const NFL_MAX_WEEK = 5;

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

const SLOT = {
  0:'QB', 2:'RB', 4:'WR', 6:'TE', 7:'OP', 16:'DST', 17:'K', 20:'BN', 21:'IR',
  23:'FLEX', 24:'FLEX', 25:'FLEX', 26:'FLEX', 27:'FLEX'
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


function mask(v) {
  if (!v) return '';
  const s = String(v);
  if (s.length <= 12) return s;
  return s.slice(0, 6) + '…' + s.slice(-6);
}

function guessCurrentWeek(){
  const urlW = Number(new URL(location.href).searchParams.get('week'));
  if (Number.isFinite(urlW) && urlW >= 1) return clamp(urlW,1,NFL_MAX_WEEK);
  const ls = Number(localStorage.getItem('ff.week'));
  if (Number.isFinite(ls) && ls >= 1) return clamp(ls,1,NFL_MAX_WEEK);
  return NFL_MAX_WEEK;
}
async function getRosterFromUpstream({ season, leagueId, week, teamId, req, debug }) {
  if (!season || !leagueId) throw new Error('season and leagueId are required');
let data = null;
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const params = new URLSearchParams({
    matchupPeriodId: String(week || guessCurrentWeek()),
    scoringPeriodId: String(week || guessCurrentWeek()),
  });
  params.append('view', 'mTeam');
  params.append('view', 'mRoster');
  params.append('view', 'mSettings');

  const url = `${base}?${params.toString()}`;
  console.log('[roster] fetch:', url);

const cands = await resolveEspnCredCandidates({ req, leagueId, teamId, debug });
if (!cands.length) console.warn('[espn/league] no ESPN creds available for league', { leagueId });

let last = null;
for (const cand of cands) {
  const res = await fetchJsonWithCred(url.toString(), cand);
  if (res.ok && res.json) {
    try { req.res?.set?.('x-espn-cred-source', cand.source || 'unknown'); } catch {}
    data = res.json;
    break;
  }
  last = { cand, res };
  if (res.status === 401) {
    console.warn('[espn/league] 401 with candidate', {
      leagueId, source: cand.source, member_id: cand.member_id || null,
      bodySnippet: (res.text||'').slice(0,240)
    });
  }
}
if (!data) {
  console.warn(
    `[espn/league] repro: curl -i '${url}' -H 'Accept: application/json, text/plain, */*' ` +
    `-H 'User-Agent: ff-platform-service/1.0' -H 'Cookie: espn_s2=${last?.cand?.s2||''}; SWID=${last?.cand?.swid||''}'`
  );
  throw new Error(`ESPN ${last?.res?.status || 401} ${last?.res?.statusText || ''}`);
}

  const errors = [];
   winner = null, lastCand = null;

  for (const cand of cands) {
    lastCand = cand;
    const res = await fetchJsonWithCred(url, cand);
    if (res.ok && res.json) { data = res.json; winner = cand; break; }

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
  }

  if (!data) {
    const s2 = lastCand?.s2 || candidates[0]?.s2 || '';
    const swid = lastCand?.swid || candidates[0]?.swid || '';
const s2Out = s2;
const swidOut = swid;


    console.warn('[espn/roster] all candidates failed', {
      leagueId, teamId,
      tried: candidates.map(c => c.source),
      lastError: errors[errors.length - 1] || 'unauthorized',
      url,
    });
    console.warn(
      `[espn/roster] repro: curl -i '${url}' -H 'Accept: application/json, text/plain, */*' ` +
      `-H 'User-Agent: ff-platform-service/1.0' ` +
      `-H 'Cookie: espn_s2=${s2Out}; SWID=${swidOut}'`
    );
    throw new Error(errors[0] || 'ESPN 401');
  }

  // Let FE/devtools know which credential source worked
  if (winner) {
    try { req.res?.set?.('x-espn-cred-source', winner.source || 'unknown'); } catch {}
  }

  // ---- normalization (unchanged) ----
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
