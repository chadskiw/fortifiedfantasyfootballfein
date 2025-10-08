// routes/espn/roster.js
const express = require('express');
const router  = express.Router();

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

// --- core ESPN fetcher ---
async function getRosterFromUpstream({ season, leagueId, week, teamId, req }) {
  if (!season || !leagueId) throw new Error('season and leagueId are required');

  const { swid, s2 } = readEspnCreds(req);
  if (!swid || !s2) {
    console.warn('[roster] Missing SWID/S2 — ESPN may reject');
  }

  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const params = new URLSearchParams({
    matchupPeriodId: String(week || 1),
    scoringPeriodId: String(week || 1),
  });
  // NOTE: when using URLSearchParams, use append() for repeated keys
  params.append('view', 'mTeam');
  params.append('view', 'mRoster');
  params.append('view', 'mSettings');

  const url = `${base}?${params.toString()}`;
  console.log('[roster] fetch:', url);

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'ff-platform-service/1.0',
  };
  if (swid && s2) {
    // keep order: espn_s2; SWID
    headers['Cookie'] = `espn_s2=${s2}; SWID=${swid}`;
  }

  // --- fail-log (once per shape) ---
  if (!global.__espnFailKeys) global.__espnFailKeys = new Set();
  function logFailOnce({ status, statusText, bodySnippet }) {
    const key = `${leagueId}|${teamId ?? 'all'}|w${week || 1}|${status}`;
    if (global.__espnFailKeys.has(key)) return;
    global.__espnFailKeys.add(key);

    const curl = [
      'curl',
      '-i',
      `'${url}'`,
      "-H 'Accept: application/json, text/plain, */*'",
      "-H 'User-Agent: ff-platform-service/1.0'",
      ...(swid && s2 ? ["-H 'Cookie: espn_s2=<REDACTED>; SWID=<REDACTED>'"] : [])
    ].join(' ');

    console.error('[espn/roster] upstream failure sample →', {
      season,
      leagueId,
      teamId: teamId ?? null,
      week: week || 1,
      status,
      statusText,
      url,
      bodySnippet
    });
    console.error('[espn/roster] repro (cookies redacted):', curl);
  }

  const r = await fetch(url, { headers });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const snippet = text.slice(0, 512);
    logFailOnce({ status: r.status, statusText: r.statusText, bodySnippet: snippet });
    throw new Error(`ESPN ${r.status} ${r.statusText} – ${snippet}`);
  }

  const data = await r.json();

  // Helpers to normalize ESPN’s shapes
  const teamNameOf = (t) => {
    const loc = t?.location || t?.teamLocation || '';
    const nick = t?.nickname || t?.teamNickname || '';
    return `${loc} ${nick}`.trim() || t?.name || `Team ${t?.id}`;
  };

  const rosterEntriesOf = (t) => {
    // Usually under t.roster.entries[]
    const entries = t?.roster?.entries || [];
    return entries.map(e => {
      const p = e.playerPoolEntry?.player || e.player || {};
      return {
        lineupSlotId: e.lineupSlotId ?? e.player?.lineupSlotId,
        onTeam: true,
        player: {
          id: p.id,
          fullName: p.fullName || p.displayName || p.name,
          defaultPositionId: p.defaultPositionId,
          proTeamId: p.proTeamId,
          proTeamAbbreviation: p.proTeamAbbreviation,
          headshot: p.headshot || p?.ownership?.profile?.headshot || null,
          // sometimes ESPN nests images elsewhere:
          image: p.image || null,
          photo: p.photo || null,
          avatar: p.avatar || null,
          // pass through if your upstream has FantasyPros id mapped
          fantasyProsId: p.fantasyProsId || p.fpId
        }
      };
    });
  };

  // Single-team mode
  if (teamId != null) {
    const team = (data.teams || []).find(t => Number(t.id) === Number(teamId));
    if (!team) {
      return { ok: true, team_name: `Team ${teamId}`, players: [] };
    }
    const players = rosterEntriesOf(team);
    return { ok: true, team_name: teamNameOf(team), players };
  }

  // League-wide
  const teams = (data.teams || []).map(t => ({
    teamId: t.id,
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
