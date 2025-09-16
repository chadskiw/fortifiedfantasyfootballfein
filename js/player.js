/* ---------------------------------------------------------------------------
   Universal Player Model
   - Single source of truth keyed by { name, teamAbbr, position }
   - Ingests ESPN, FantasyPros, FEIN roster/free-agent shapes
   - Holds derived metrics (proj, fmv, actual) and misc (opp, dvp, bye, ids)
   - Back-compat getters mirror legacy fields so old code continues to run
--------------------------------------------------------------------------- */

const ABBR_FIX = { JAC: "JAX", JAX: "JAX", WAS: "WSH", WSH: "WSH", OAK: "LV", SD: "LAC", LA: "LAR" };
const normAbbr = (s) => ABBR_FIX[String(s || "").toUpperCase()] || String(s || "").toUpperCase();
const normPos  = (s) => String(s || "").toUpperCase().replace("DST", "D/ST");

/** Canonical key builder: {name, teamAbbr, position} */
export function makePlayerKey({ name, teamAbbr, position }) {
  return JSON.stringify({
    name: String(name || "").trim(),
    teamAbbr: normAbbr(teamAbbr || ""),
    position: normPos(position || ""),
  });
}

/** A normalized, mergeable player. */
export class UniversalPlayer {
  constructor({ name, teamAbbr, position }) {
    this.name      = String(name || "").trim();
    this.teamAbbr  = normAbbr(teamAbbr || "");
    this.position  = normPos(position || "");

    // IDs from providers (optional)
    this.ids = {
      espn: null,
      fpros: null,
    };

    // Ownership / league context (optional)
    this.ownerTeamId   = null;
    this.ownerTeamName = null;
    this.isFA = false;

    // Scoring/metrics
    this.metrics = {
      proj: null,   // projected points (our default “Proj” metric)
      fmv:  null,   // Fair Market Value-esque metric
      actual: null, // last actual (if present)
    };

    // Opponent context
    this.opponent   = "";    // "BUF", "BYE", ""
    this.defRank    = null;  // DvP / defensive rank
    this.byeWeek    = null;

    // Extras
    this.headshotUrl = null;
  }

  /** The canonical key string for Maps/indices. */
  get key() { return makePlayerKey(this); }

  /** Merge another source of data into this player (non-destructive). */
  merge(from = {}) {
    const maybe = (a, b) => (b !== undefined && b !== null ? b : a);

    // IDs
    if (from.ids) {
      this.ids.espn  = maybe(this.ids.espn,  from.ids.espn);
      this.ids.fpros = maybe(this.ids.fpros, from.ids.fpros);
    }

    // Ownership
    this.ownerTeamId   = maybe(this.ownerTeamId,   from.ownerTeamId);
    this.ownerTeamName = maybe(this.ownerTeamName, from.ownerTeamName);
    this.isFA          = maybe(this.isFA,          from.isFA);

    // Metrics
    if (from.metrics) {
      this.metrics.proj   = maybe(this.metrics.proj,   numOrNull(from.metrics.proj));
      this.metrics.fmv    = maybe(this.metrics.fmv,    numOrNull(from.metrics.fmv));
      this.metrics.actual = maybe(this.metrics.actual, numOrNull(from.metrics.actual));
    }

    // Opponent
    this.opponent = maybe(this.opponent, from.opponent);
    this.defRank  = maybe(this.defRank,  numOrNull(from.defRank));
    this.byeWeek  = maybe(this.byeWeek,  numOrNull(from.byeWeek));

    // Extras
    this.headshotUrl = maybe(this.headshotUrl, from.headshotUrl);

    return this;
  }

  /* -------- Back-compat getters so old code keeps working -------- */
  get pos()  { return this.position; }
  get proj() { return this.metrics.proj; }
  get fmv()  { return this.metrics.fmv; }
  get actual(){ return this.metrics.actual; }
  get teamAbbreviation() { return this.teamAbbr; } // sometimes older code used this
  get fullName() { return this.name; }             // sometimes older code used this

  toJSON() {
    return {
      name: this.name,
      teamAbbr: this.teamAbbr,
      position: this.position,
      ids: { ...this.ids },
      ownerTeamId: this.ownerTeamId,
      ownerTeamName: this.ownerTeamName,
      isFA: this.isFA,
      metrics: { ...this.metrics },
      opponent: this.opponent,
      defRank: this.defRank,
      byeWeek: this.byeWeek,
      headshotUrl: this.headshotUrl,
    };
  }

  /* --------- Provider-specific normalizers (static) --------- */

  /** From an ESPN “player”/FA/roster row (various shapes supported). */
  static fromEspn(row = {}, { ownerTeamId = null, ownerTeamName = null } = {}) {
    // Flexible extraction
    const name = row.name || row.fullName || row.playerName || row.player?.fullName || "";
    const position =
      normPos(row.position || row.pos || row.player?.defaultPosition || row.player?.position ||
              row.positionAbbr || row.position_id || "");
    const teamAbbr =
      normAbbr(row.teamAbbr || row.team || row.proTeamAbbr || row.proTeam || row.player?.proTeamAbbreviation || "");

    const p = new UniversalPlayer({ name, teamAbbr, position });

    // ids
    const espnId = row.id ?? row.playerId ?? row.player?.id ?? null;
    p.ids.espn = numOrNull(espnId);

    // ownership
    p.ownerTeamId   = numOrNull(row.ownerTeamId ?? ownerTeamId);
    p.ownerTeamName = (row.ownerTeamName ?? ownerTeamName) || (p.ownerTeamId != null ? `Team ${p.ownerTeamId}` : null);
    p.isFA          = !!(row.isFA || row.ownerType === "fa" || p.ownerTeamId == null);

    // metrics
    const proj = numOrNull(row.proj ?? row.projected ?? row.projection);
    const fmv  = numOrNull(row.fmv);
    const actual = numOrNull(row.actual);
    p.metrics = { proj, fmv, actual };

    // opponent / ranks
    p.opponent = String(row.opponent || row.opp || "").toUpperCase();
    p.defRank  = numOrNull(row.defensiveRank ?? row.dvp);
    p.byeWeek  = numOrNull(row.byeWeek);

    // headshot
    if (p.ids.espn) {
      p.headshotUrl = `https://a.espncdn.com/i/headshots/nfl/players/full/${p.ids.espn}.png`;
    }

    return p;
  }

  /** From a FantasyPros row (projection/ECR/FMVs, etc.) */
  static fromFantasyPros(row = {}) {
    const name = row.name || row.player || row.Player || "";
    const position = normPos(row.position || row.Pos || "");
    const teamAbbr = normAbbr(row.team || row.Team || row.teamAbbr || "");

    const p = new UniversalPlayer({ name, teamAbbr, position });

    // optional FP id
    p.ids.fpros = row.id ?? row.player_id ?? null;

    // metrics
    const proj = numOrNull(row.proj ?? row.Projection ?? row.pts);
    const fmv  = numOrNull(row.fmv ?? row.FMV);
    p.metrics  = {
      proj,
      fmv,
      actual: numOrNull(row.actual),
    };

    // opponent-ish (if present in FP feed)
    p.opponent = String(row.opp || row.Opp || "").toUpperCase();
    p.defRank  = numOrNull(row.dvp || row.DvP);

    return p;
  }

  /** From our FEIN roster/free-agent shape (already close to normalized). */
  static fromFein(row = {}) {
    const p = new UniversalPlayer({
      name: row.name,
      teamAbbr: row.teamAbbr || row.proTeamAbbr || row.team,
      position: row.position || row.pos,
    });

    p.ids.espn = numOrNull(row.id);
    p.ownerTeamId   = numOrNull(row.ownerTeamId);
    p.ownerTeamName = row.ownerTeamName || (p.ownerTeamId != null ? `Team ${p.ownerTeamId}` : null);
    p.isFA = !!row.isFA;

    p.metrics = {
      proj:   numOrNull(row.proj),
      fmv:    numOrNull(row.fmv),
      actual: numOrNull(row.actual),
    };

    p.opponent = String(row.opponent || "").toUpperCase();
    p.defRank  = numOrNull(row.defRank ?? row.defensiveRank);
    p.byeWeek  = numOrNull(row.byeWeek);

    if (p.ids.espn) {
      p.headshotUrl = `https://a.espncdn.com/i/headshots/nfl/players/full/${p.ids.espn}.png`;
    }

    return p;
  }
}

/* ------------------------- Store / facade ------------------------- */

export class PlayerStore {
  constructor() {
    /** Map<string key, UniversalPlayer> */
    this.map = new Map();
  }

  clear() { this.map.clear(); }

  /** Get-or-create by universal key parts. */
  getOrCreate({ name, teamAbbr, position }) {
    const key = makePlayerKey({ name, teamAbbr, position });
    let p = this.map.get(key);
    if (!p) {
      p = new UniversalPlayer({ name, teamAbbr, position });
      this.map.set(key, p);
    }
    return p;
  }

  /** Ingest an array of ESPN-shape rows (FA, roster, or global). */
  upsertEspnList(list = [], { ownerTeamId = null, ownerTeamName = null } = {}) {
    for (const row of list) {
      const p = UniversalPlayer.fromEspn(row, { ownerTeamId, ownerTeamName });
      const existing = this.map.get(p.key);
      existing ? existing.merge(p) : this.map.set(p.key, p);
    }
    return this;
  }

  /** Ingest a FEIN roster payload: { teamId, team_name, players:[...] } */
  upsertFeinRosterPayload(payload = {}) {
    const ownerTeamId = numOrNull(payload.teamId);
    const ownerTeamName = payload.team_name || (ownerTeamId != null ? `Team ${ownerTeamId}` : null);
    const rows = Array.isArray(payload.players) ? payload.players : [];
    for (const r of rows) {
      const p = UniversalPlayer.fromFein({ ...r, ownerTeamId, ownerTeamName });
      const existing = this.map.get(p.key);
      existing ? existing.merge(p) : this.map.set(p.key, p);
    }
    return this;
  }

  /** Ingest FantasyPros rows. */
  upsertFantasyProsList(list = []) {
    for (const row of list) {
      const p = UniversalPlayer.fromFantasyPros(row);
      const existing = this.map.get(p.key);
      existing ? existing.merge(p) : this.map.set(p.key, p);
    }
    return this;
  }

  /** Array snapshot (optionally filter). */
  toArray(filterFn = null) {
    const arr = Array.from(this.map.values());
    return typeof filterFn === "function" ? arr.filter(filterFn) : arr;
  }

  /** Legacy: produce the “old” shape for consumers that expect it. */
  toLegacyArray() {
    return this.toArray().map(p => ({
      id: p.ids.espn ?? p.ids.fpros ?? null,
      name: p.name,
      position: p.position,
      pos: p.position,               // old alias
      teamAbbr: p.teamAbbr,
      proj: p.metrics.proj,
      fmv:  p.metrics.fmv,
      actual: p.metrics.actual,
      opponent: p.opponent,
      defensiveRank: p.defRank,
      ownerTeamId: p.ownerTeamId,
      ownerTeamName: p.ownerTeamName,
      isFA: p.isFA,
      byeWeek: p.byeWeek,
      headshotUrl: p.headshotUrl,
    }));
  }
}

/* --------------------------- tiny utils --------------------------- */
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------ Minimal facade API ---------------------- */
/**
 * For legacy code that previously imported functions from player.js, expose a
 * couple of helpers that mimic the old vibe but run through UniversalPlayer.
 */
export const Player = {
  /** New hotness: create a store and feed it things. */
  createStore() { return new PlayerStore(); },

  /** Back-compat helper: normalize any list of rows into a legacy-ish array. */
  normalizeAny(list = []) {
    const store = new PlayerStore();
    // Heuristics: try to recognize shapes; this is intentionally forgiving
    for (const r of list) {
      // FEIN-like?
      if ("ownerTeamId" in r || "isFA" in r || "proj" in r) {
        store.upsertFeinRosterPayload({ teamId: r.ownerTeamId ?? null, team_name: r.ownerTeamName ?? null, players: [r] });
        continue;
      }
      // ESPN-like?
      if ("player" in r || "proTeam" in r || "proTeamAbbr" in r || "position" in r) {
        store.upsertEspnList([r]);
        continue;
      }
      // Assume FantasyPros
      store.upsertFantasyProsList([r]);
    }
    return store.toLegacyArray();
  }
};
