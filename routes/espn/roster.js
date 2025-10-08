// routes/espn/roster.js
// TRUE_LOCATION: routes/espn/roster.js
// IN_USE: yes (FEIN roster + league-wide roster fetcher)

const express = require('express');
const router  = express.Router();

/* ---------------- ESPN → FF maps (corrected) ---------------- */

const TEAM_ABBR = {
  1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',
  10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',
  18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',
  26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU'
};

// ESPN defaultPositionId -> canonical position
const POS_MAP = {
  1:'QB',
  2:'RB',
  3:'WR',
  4:'TE',
  5:'K',
  16:'DST'
};

/* ---------------- lineup slot labelling ---------------- */

function slotLabel(lineupSlotId, defaultPositionId) {
  const MAP = {
    0:'QB',
    2:'RB',
    3:'WR',
    4:'TE',
    5:'WR/TE',
    6:'RB/WR',
    7:'OP',             // superflex/OP
    8:'TAXI',
    9:'RB/WR/TE',       // flex variant
    10:'QB/RB/WR/TE',
    11:'WR/TE',
    12:'RB/WR',
    13:'RB/TE',
    14:'QB/RB/WR/TE',
    15:'BN',
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

  if (Object.prototype.hasOwnProperty.call(MAP, lineupSlotId)) {
    return MAP[lineupSlotId];
  }

  // Fallback: if we know the player's default position, use that as chip
  if (defaultPositionId != null) {
    const DEF_POS = { 1:'QB', 2:'RB', 3:'WR', 4:'TE', 5:'K', 16:'DST' };
    if (DEF_POS[defaultPositionId]) return DEF_POS[defaultPositionId];
  }

  // Last resort: treat unknowns as bench but log once
  if (!global.__unkSlots) global.__unkSlots = new Set();
  if (!global.__unkSlots.has(lineupSlotId)) {
    console.warn('[roster] Unknown lineupSlotId:', lineupSlotId);
    global.__unkSlots.add(lineupSlotId);
  }
  return 'BE';
}

/* ---------------- creds from cookies/headers ---------------- */

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

/* ---------------- upstream fetcher (ESPN v3) ---------------- */

async function getRosterFromUpstream({ season, leagueId, week, teamId, req }) {
  if (!season || !leagueId) throw new Error('season and leagueId are required');

  const { swid, s2 } = readEspnCreds(req);
  if (!swid || !s2) {
    // Public leagues may still work; warn for visibility.
    console.warn('[roster] Missing SWID/S2 — ESPN may reject');
  }

  const base = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  // Multiple "view" params are supported; URLSearchParams will include all.
  const params = new URLSearchParams({
    matchupPeriodId: String(week || 1),
    scoringPeriodId: String(week || 1),
  });
  params.append('view', 'mTeam');
  params.append('view', 'mRoster');
  params.append('view', 'mSettings');

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
    if (!team) {
      return { ok: true, team_name: `Team ${teamId}`, players: [] };
    }
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

/* ---------------- headshot resolver ---------------- */

function resolveHeadshot(p, pos, teamAbbr) {
  const cand =
    p?.headshot?.href ||
    p?.headshot ||
    p?.image?.href ||
    p?.photo?.href ||
    p?.avatar?.href ||
    null;

  if (cand) return cand;

  // D/ST use team logo
  if (pos === 'DST' && teamAbbr) {
    const slug = String(teamAbbr).toLowerCase();
    return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${slug}.png&h=80&w=80&scale=crop`;
  }

  // ESPN id-based fallback
  if (p?.id) {
    return `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`;
  }

  return 'https://img.fortifiedfantasy.com/avatars/default.png';
}

/* ---------------- position corrections ---------------- */

function correctKnownPosition(name, pos) {
  const n = String(name || '').toLowerCase();
  if (n.includes('jaxon smith')) return 'WR';  // JSN safety
  if (n.includes('taysom hill')) return 'TE';  // ESPN sometimes lists as QB
  return pos;
}

/* ---------------- entry → player normalization ---------------- */

function espnRosterEntryToPlayer(entry = {}) {
  try {
    const p = entry?.player || entry || {};

    const teamAbbr =
      p?.proTeamAbbreviation ||
      TEAM_ABBR[p?.proTeamId] ||
      p?.proTeam ||
      '';

    // Position: prefer mapped id, then any string present
    let pos =
      POS_MAP[p?.defaultPositionId] ||
      p?.position ||
      p?.defaultPosition ||
      (p?.player && POS_MAP[p?.player?.defaultPositionId]) ||
      '';

    pos = correctKnownPosition(p?.fullName || p?.displayName || p?.name, pos);

    // Slot: resolve robustly; never blank
    const slot = slotLabel(entry?.lineupSlotId, p?.defaultPositionId);
    const isStarter = !['BE','BN','IR','ES'].includes(String(slot).toUpperCase());

    const fpId =
      p?.fantasyProsId ||
      p?.fpId ||
      p?.externalIds?.fantasyProsId ||
      p?.externalIds?.fpid ||
      undefined;

    const headshot = resolveHeadshot(p, pos, teamAbbr);

    return {
      id: p?.id || p?.playerId,
      name: p?.fullName || p?.displayName || p?.name || 'Unknown',
      team: teamAbbr || '',
      position: pos || '',       // canonical: QB/RB/WR/TE/K/DST
      slot,                      // QB/RB/WR/TE/FLEX/K/DST/BE/IR/...
      isStarter,
      fpId,
      headshot
    };
  } catch (e) {
    console.warn('[roster] map entry failed:', e);
    return {
      id: undefined,
      name: 'Unknown',
      team: '',
      position: '',
      slot: 'BE',
      isStarter: false,
      fpId: undefined,
      headshot: '/img/placeholders/player.png'
    };
  }
}

/* ---------------- routes ---------------- */

router.get('/roster/selftest', (_req, res) => {
  res.json({ ok:true, msg:'roster router mounted' });
});

router.get('/roster', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const week     = Number(req.query.week || 1);
    const teamId   = (req.query.teamId != null) ? Number(req.query.teamId) : null;

    if (!season || !leagueId) {
      return res.status(400).json({ ok:false, error:'season and leagueId are required' });
    }

    const raw = await getRosterFromUpstream({ season, leagueId, week, teamId, req });

    if (teamId != null) {
      const players = (raw?.players || []).map(espnRosterEntryToPlayer);
      return res.json({
        ok: true,
        platform: 'espn',
        leagueId, season, week, teamId,
        team_name: raw?.team_name || `Team ${teamId}`,
        players
      });
    }

    const teams = (raw?.teams || []).map(t => ({
      teamId: t?.teamId,
      team_name: t?.team_name,
      players: (t?.players || []).map(espnRosterEntryToPlayer)
    }));

    return res.json({ ok:true, platform:'espn', leagueId, season, week, teams });
  } catch (err) {
    console.error('[espn/roster] error:', err);
    res.status(500).json({ ok:false, error:String(err?.message || err) });
  }
});

/* ---------------- exports ---------------- */

module.exports = router;
