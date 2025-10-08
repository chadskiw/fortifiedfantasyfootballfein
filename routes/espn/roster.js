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

/* ---------------- upstream fetcher (ESPN v3) ---------------- */

async function getRosterFromUpstream({ season, leagueId, week=1, teamId, req, debug }) {
  if (!season || !leagueId) throw new Error('season and leagueId are required');

  const { swid, s2 } = readEspnCreds(req);
  if (!swid || !s2) {
    console.warn('[roster] Missing SWID/S2 — ESPN may reject');
  }

  const hosts = [
    'https://lm-api-reads.fantasy.espn.com', // primary read host
    'https://fantasy.espn.com'               // fallback host
  ];

  // Build shared query
  const params = new URLSearchParams({
    matchupPeriodId: String(week || 1),
    scoringPeriodId: String(week || 1),
  });
  params.append('view', 'mTeam');
  params.append('view', 'mRoster');
  params.append('view', 'mSettings');

  // ESPN seems happiest when we look like the web app
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'ff-platform-service/1.0',
    'Origin': 'https://fantasy.espn.com',
    'Referer': `https://fantasy.espn.com/football/team?leagueId=${leagueId}&seasonId=${season}`,
    'x-fantasy-platform': 'kona',
    'x-fantasy-source': 'fantasy_web',
  };
  if (swid && s2) {
    // cookie order matters for some WAF paths: espn_s2 first, then SWID
    headers['Cookie'] = `espn_s2=${s2}; SWID=${swid}`;
    // Belt & suspenders: pass through as headers too (harmless if ignored)
    headers['x-espn-s2'] = s2;
    headers['x-espn-swid'] = swid;
  }

  const path = `/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const errors = [];

  // Try hosts in order until one returns 200
  let data = null;
  for (const host of hosts) {
    const url = `${host}${path}?${params.toString()}`;
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        const msg = `ESPN ${r.status} ${r.statusText} @ ${host}`;
        errors.push(debug ? `${msg} – ${txt.slice(0, 256)}` : msg);
        continue;
      }
      data = await r.json();
      break; // success
    } catch (e) {
      errors.push(`Fetch failed @ ${host}: ${String(e.message || e)}`);
    }
  }

  if (!data) {
    throw new Error(errors.join(' | '));
  }

  // --- helpers local to this function ---
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

  // Single-team response
  if (teamId != null) {
    const team = (data?.teams || []).find(t => Number(t?.id) === Number(teamId));
    if (!team) return { ok: true, team_name: `Team ${teamId}`, players: [] };
    return { ok: true, team_name: teamNameOf(team), players: rosterEntriesOf(team) };
  }

  // League-wide response
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
      p?.position ||
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
