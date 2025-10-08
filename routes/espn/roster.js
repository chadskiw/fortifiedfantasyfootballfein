// routes/espn/roster.js
// TRUE_LOCATION: routes/espn/roster.js
// IN_USE: yes — FEIN roster + league-wide roster

const express = require('express');
const router  = express.Router();

/* ---------------- ESPN → FF maps ---------------- */

const TEAM_ABBR = {
  1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',
  10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',
  18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',
  26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU'
};

// ESPN defaultPositionId -> canonical position
const POS_MAP = { 1:'QB', 2:'RB', 3:'WR', 4:'TE', 5:'K', 16:'DST' };

/* ---------------- lineup slot labelling ---------------- */

function slotLabel(lineupSlotId, defaultPositionId) {
  const MAP = {
    0:'QB', 2:'RB', 3:'WR', 4:'TE', 5:'WR/TE', 6:'RB/WR', 7:'OP',
    8:'TAXI', 9:'RB/WR/TE', 10:'QB/RB/WR/TE', 11:'WR/TE', 12:'RB/WR',
    13:'RB/TE', 14:'QB/RB/WR/TE', 15:'BN',
    16:'DST', 17:'K', 18:'P', 19:'HC', 20:'BE', 21:'IR', 22:'ES',
    23:'FLEX', 24:'ED', 25:'DL', 26:'LB', 27:'DB', 28:'DP'
  };

  if (Object.prototype.hasOwnProperty.call(MAP, lineupSlotId)) {
    return MAP[lineupSlotId];
  }

  if (defaultPositionId != null) {
    const DEF_POS = { 1:'QB', 2:'RB', 3:'WR', 4:'TE', 5:'K', 16:'DST' };
    if (DEF_POS[defaultPositionId]) return DEF_POS[defaultPositionId];
  }

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
function espnPlayersUrl({ season, leagueId, week }) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}/players`;
  const sp = new URLSearchParams();
  if (week) sp.set('scoringPeriodId', String(week));
  sp.set('view', 'kona_player_info');
  sp.set('limit', '1000');
  sp.set('offset', '0');
  return `${base}?${sp.toString()}`;
}
/* ---------------- upstream fetcher (ESPN v3) ---------------- */

async function getRosterFromUpstream({ season, leagueId, week = 1, teamId, req, debug }) {
 return espnPlayersUrl({season, leagueId, week});
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

  if (pos === 'DST' && teamAbbr) {
    const slug = String(teamAbbr).toLowerCase();
    return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${slug}.png&h=80&w=80&scale=crop`;
  }

  if (p?.id) {
    return `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`;
  }

  return 'https://img.fortifiedfantasy.com/avatars/default.png';
}

/* ---------------- position corrections ---------------- */

function correctKnownPosition(name, pos) {
  const n = String(name || '').toLowerCase();
  if (n.includes('jaxon smith')) return 'WR';
  if (n.includes('taysom hill')) return 'TE';
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

    // Base position from ESPN id/strings
    let pos =
      POS_MAP[p?.defaultPositionId] ||
      p?.pos ||
     // p?.position ||
      p?.defaultPosition ||
      (p?.player && POS_MAP[p?.player?.defaultPositionId]) ||
      '';

    // Slot (always derive)
    const slot = slotLabel(entry?.lineupSlotId, p?.defaultPositionId);
    const slotUp = String(slot || '').toUpperCase();

    // If ESPN didn’t give a position, derive from slot; else FLEX fallback
    if (!pos) {
      if (['QB','RB','WR','TE','K','DST'].includes(slotUp)) {
        pos = slotUp;
      } else {
        pos = 'FLEX';
      }
    }

    // Clean special cases after fallback
    pos = correctKnownPosition(p?.fullName || p?.displayName || p?.name, pos);

    const isStarter = !['BE','BN','IR','ES'].includes(slotUp);

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
      position: pos,           // guaranteed non-empty
      slot,                    // readable slot
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
      position: 'FLEX',
      slot: 'BE',
      isStarter: false,
      fpId: undefined,
      headshot: 'https://img.fortifiedfantasy.com/avatars/default.png'
    };
  }
}

/* ---------------- routes ---------------- */

router.get('/roster/selftest', (_req, res) => {
  res.json({ ok:true, msg:'roster router mounted' });
});

// GET /api/platforms/espn/roster?season=2025&leagueId=...&teamId=7[&week=1][&scope=season][&debug=1]
router.get('/roster', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const week     = Number(req.query.week || 1);
    const teamId   = (req.query.teamId != null) ? Number(req.query.teamId) : null;
    const debug    = String(req.query.debug || '') === '1';

    if (!season || !leagueId) {
      return res.status(400).json({ ok:false, error:'season and leagueId are required' });
    }

    // scope is accepted but not used server-side; FE can pass it freely
    const _scope = req.query.scope; // eslint appeaser

    const raw = await getRosterFromUpstream({ season, leagueId, week, teamId, req, debug });

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
