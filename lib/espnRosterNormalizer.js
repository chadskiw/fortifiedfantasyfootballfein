// TRUE_LOCATION: src/lib/EspnRosterNormalizer.js
// PURPOSE: Map ESPN roster payloads into Fortified Fantasy's normalized player shape.
// EXPORTS: class EspnRosterNormalizer

class EspnRosterNormalizer {
  constructor(opts = {}) {
    // allow custom overrides (e.g., add new slots/positions)
    this.teamAbbr = Object.assign({}, EspnRosterNormalizer.TEAM_ABBR, opts.teamAbbr || {});
    this.posMap   = Object.assign({}, EspnRosterNormalizer.POS,       opts.posMap   || {});
    this.slotMap  = Object.assign({}, EspnRosterNormalizer.SLOT,      opts.slotMap  || {});
  }

  /** Normalize a single ESPN roster entry → FF player object */
  normalizePlayer(entry = {}) {
    // ESPN sometimes nests the "player" object; sometimes the entry already is the player
    const p = entry.player || entry;

    // --- Team abbreviation ---
    const team =
      p.proTeamAbbreviation ||
      this.teamAbbr[p.proTeamId] ||
      p.proTeam ||
      '';

    // --- Canonical position (QB/RB/WR/TE/K/DST) ---
    const position =
      p.position ||
      p.defaultPosition ||
      this.posMap[p.defaultPositionId] ||
      '';

    // --- Lineup slot (QB/RB/WR/TE/FLEX/K/DST/BE/IR/OP/WR/TE etc.) ---
    // Prefer explicit string if present, else map from lineupSlotId
    let slot =
      entry.slot ||
      this.slotMap[entry.lineupSlotId];

    // If we still don't have a sensible slot, pick one by heuristics
    if (!slot) {
      if (entry.onTeam === false) slot = 'FA';
      else if (['K', 'DST'].includes(position)) slot = position; // keep K/DST as slot when unknown
      else if (position) slot = position;
      else slot = 'BE';
    }

    const slotUpper = String(slot).toUpperCase();

    // --- Starter vs Bench ---
    const isStarter = !['BE', 'BN', 'IR', 'OUT', 'NA', 'PUP'].includes(slotUpper) &&
                      !slotUpper.includes('TAXI');

    // --- FantasyPros id passthrough (optional) ---
    const fpId =
      p.fantasyProsId ||
      (p.externalIds && (p.externalIds.fantasyProsId || p.externalIds.fpid)) ||
      entry.fpId ||
      undefined;

    // --- Headshot URL, with a few common shapes handled ---
    const headshot =
      (p.headshot && (p.headshot.href || p.headshot.url)) ||
      p.headshot ||
      p.imageUrl ||
      null;

    return {
      id: p.id || p.playerId || p.espnId || undefined,
      name: p.fullName || p.displayName || p.name || '',
      team,
      position,  // ← ALWAYS a string if ESPN had defaultPositionId/position
      slot,      // ← ALWAYS a string label (QB/RB/WR/TE/FLEX/K/DST/BE/IR/OP…)
      isStarter,
      fpId,
      headshot,
    };
  }

  /** Normalize a single team block that contains {teamId, team_name, players:[…]} */
  normalizeTeam(teamBlock = {}) {
    const players = Array.isArray(teamBlock.players) ? teamBlock.players : [];
    return {
      teamId: this.#toInt(teamBlock.teamId),
      team_name: teamBlock.team_name || teamBlock.teamName || `Team ${teamBlock.teamId ?? ''}`.trim(),
      players: players.map(p => this.normalizePlayer(p)),
    };
  }

  /** Normalize a league-wide payload with shape {teams:[…]} or {entries:[…]} */
  normalizeLeague(payload = {}) {
    const teams = payload.teams || payload.entries || [];
    return teams.map(t => this.normalizeTeam(t));
  }

  /** Convenience: bulk normalize a list of entries (array of ESPN roster entries) */
  normalizePlayers(list = []) {
    return (list || []).map(p => this.normalizePlayer(p));
  }

  // ------------------------ helpers ------------------------
  #toInt(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  // -------- static lookup tables (can be extended) --------
  static TEAM_ABBR = {
    1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',
    10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',
    18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',
    26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU'
  };

  // ESPN defaultPositionId → canonical position
  static POS = {
    1:'QB', 2:'QB', 3:'RB', 4:'WR', 5:'TE', 16:'DST', 17:'K'
  };

  // ESPN lineupSlotId → slot label
  static SLOT = {
    0:'QB',
    2:'RB',
    3:'RB/WR',
    4:'WR',
    5:'WR/TE',
    6:'TE',
    7:'OP',
    16:'DST',
    17:'K',
    20:'BE',
    21:'IR',
    23:'FLEX',
    // Common extras used by some leagues:
    8:'DT', 9:'DE', 10:'LB', 11:'CB', 12:'S', 13:'DP',
    14:'DL', 15:'DB', 18:'HC', 19:'HC',
    22:'UNKNOWN'
  };
}

module.exports = EspnRosterNormalizer;
