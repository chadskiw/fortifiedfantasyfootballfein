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
