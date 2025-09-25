// src/routes/espn/normalize.js
// ESPN→Global object adapters so the rest of the app can be platform-agnostic.

function normalizeLeague(espn) {
  // Accepts raw ESPN league JSON (when you hook it up).
  // Returns a stable, platform-agnostic shape.
  if (!espn) return null;
  return {
    platform: 'espn',
    leagueId: String(espn.id ?? espn.leagueId ?? ''),
    season:   Number(espn.seasonId ?? espn.season ?? NaN),
    name:     String(espn.settings?.name ?? espn.name ?? 'ESPN League'),
    scoring: {
      type: espn.scoringType || 'H2H',
      // add fields as you need them
    },
    teams: Array.isArray(espn.teams) ? espn.teams.map(normalizeTeam) : [],
    meta: {
      draftComplete: !!espn.draftDetail,
      memberCount:   Array.isArray(espn.members) ? espn.members.length : undefined,
    }
  };
}

function normalizeTeam(t) {
  if (!t) return null;
  return {
    platform: 'espn',
    teamId: Number(t.id ?? t.teamId ?? NaN),
    name:   String(t.location ? `${t.location} ${t.nickname}`.trim() : (t.name ?? 'Team')),
    owner:  t.owners?.[0] ?? null,
    record: t.record || t.recordOverall || null,
    logo:   t.logo ?? t.logoUrl ?? null,
  };
}

module.exports = { normalizeLeague, normalizeTeam };
