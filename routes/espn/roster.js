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
function slotLabel(lineupSlotId, defaultPositionId) {
  // Known/common ESPN ids
  const MAP = {
    0:'QB',
    2:'RB',
    3:'WR',
    4:'TE',
    5:'WR/TE',          // seen in some leagues
    6:'RB/WR',          // seen in some leagues
    7:'OP',             // superflex/OP
    8:'TAXI',           // some variants
    9:'RB/WR/TE',       // another FLEX code used by some
    10:'QB/RB/WR/TE',   // super OP in custom leagues
    11:'WR/TE',         // alt id
    12:'RB/WR',         // alt id
    13:'RB/TE',         // alt id
    14:'QB/RB/WR/TE',   // alt id
    15:'BN',            // alt bench in some dumps
    16:'DST',
    17:'K',
    18:'P',
    19:'HC',
    20:'BE',
    21:'IR',
    22:'ES',
    23:'FLEX',
    24:'ED',
    25:'DL',
    26:'LB',
    27:'DB',
    28:'DP'
  };

  if (MAP.hasOwnProperty(lineupSlotId)) return MAP[lineupSlotId];

  // Fallbacks so UI is never blank:
  // 1) If it's a starter but unmapped, show the player position as the chip
  if (defaultPositionId != null) {
    const POS = { 1:'QB', 2:'RB', 3:'WR', 4:'TE', 5:'K', 16:'DST' };
    if (POS[defaultPositionId]) return POS[defaultPositionId];
  }

  // 2) Bench-style fallback:
  // ESPN treats unknown/non-active slots usually as bench. Use 'BE', but also log once.
  if (!global.__unkSlots) global.__unkSlots = new Set();
  if (!global.__unkSlots.has(lineupSlotId)) {
    console.warn('[roster] Unknown lineupSlotId:', lineupSlotId);
    global.__unkSlots.add(lineupSlotId);
  }
  return 'BE';
}

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
    // We still try (public leagues sometimes load), but warn
    console.warn('[roster] Missing SWID/S2 — ESPN may reject');
  }

  // ESPN v3 league endpoint; views that contain teams + roster entries
  const base = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const params = new URLSearchParams({
    matchupPeriodId: String(week || 1),
    scoringPeriodId: String(week || 1),
    view: 'mTeam',
    view: 'mRoster',
    view: 'mSettings'
  });
  const url = `${base}?${params.toString()}`;

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'ff-platform-service/1.0',
  };
  if (swid && s2) {
    headers['Cookie'] = `SWID=${swid}; espn_s2=${s2}`;
  }

  const r = await fetch(url, { headers });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`ESPN ${r.status} ${r.statusText} – ${text.slice(0, 256)}`);
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
let position =
  POS[p.defaultPositionId] ||
  p.position ||
  p.defaultPosition ||
  (p.player && POS[p.player?.defaultPositionId]) ||
  '';

position = correctKnownPosition(p.fullName || p.displayName || p.name, position);
if (!position && entry.lineupSlotId) {
  position = slotLabel(entry.lineupSlotId);
}


  // Slot: from lineupSlotId with safe fallbacks
const slot = slotLabel(entry.lineupSlotId, p.defaultPositionId);
const isStarter = !['BE','BN','IR','ES'].includes(String(slot).toUpperCase());
const chip = player.slot || player.position || '—';


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
router.get('/roster/slots-debug', async (req, res) => {
  try {
    const season  = Number(req.query.season);
    const leagueId= String(req.query.leagueId || '');
    const week    = Number(req.query.week || 1);
    const raw = await getRosterFromUpstream({ season, leagueId, week, teamId: null, req });
    const ids = new Set();
    (raw.teams || []).forEach(t => (t.players || []).forEach(e => {
      const id = e.lineupSlotId ?? e.player?.lineupSlotId;
      if (id != null) ids.add(id);
    }));
    res.json({ ok:true, slotIds:[...ids].sort((a,b)=>a-b) });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});


/* ===== Exports (cover CJS + ESM) ===== */
module.exports = router;   
