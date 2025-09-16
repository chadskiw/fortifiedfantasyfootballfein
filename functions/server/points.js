// server/points.js
// Standings + (optional) per-week points from ESPN Fantasy API
// Exports: getStandings({ leagueId, season, week?, swid?, s2? }) -> { ok, standings: [...] }

import fetch from "node-fetch";

/** Build Cookie header if user provided ESPN cookies (supports private leagues). */
function buildCookie({ swid, s2 }) {
  const parts = [];
  if (swid) parts.push(`SWID=${encodeURIComponent(swid)}`);
  if (s2)   parts.push(`espn_s2=${encodeURIComponent(s2)}`);
  return parts.length ? parts.join("; ") : "";
}

async function espnGetJSON(url, { swid, s2 } = {}) {
  const headers = {
    "accept": "application/json",
    "x-fantasy-source": "kona", // ESPN web client header; helps occasionally
  };
  const cookie = buildCookie({ swid, s2 });
  if (cookie) headers.cookie = cookie;

  const res = await fetch(url, { headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`Bad JSON from ESPN (${res.status})`);
  }
  if (!res.ok) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

/** Normalize league/team standings from ESPN league payload. */
function normalizeStandingsFromLeaguePayload(leagueJSON) {
  // leagueJSON.teams[] -> each has record.overall.{wins,losses,ties,pointsFor,pointsAgainst}
  if (!leagueJSON || !Array.isArray(leagueJSON.teams)) return [];

  return leagueJSON.teams.map(t => {
    const rec = t.record?.overall || {};
    return {
      teamId:        Number(t.id),
      wins:          Number(rec.wins ?? 0),
      losses:        Number(rec.losses ?? 0),
      ties:          Number(rec.ties ?? 0),
      pointsFor:     Number(rec.pointsFor ?? rec.points_for ?? 0),
      pointsAgainst: Number(rec.pointsAgainst ?? rec.points_against ?? 0),
      // weekPoints/seasonPoints filled later
    };
  });
}

/** Build a map of teamId -> points *for a given week* from the scoreboard view. */
function buildWeekPointsMap(scoreboardJSON) {
  const byTeam = new Map();
  // scoreboardJSON.schedule[] -> each item has home/away { teamId, totalPoints }
  const rows = Array.isArray(scoreboardJSON?.schedule) ? scoreboardJSON.schedule : [];
  for (const m of rows) {
    const homeId = m.home?.teamId ?? m.home?.team?.id;
    const awayId = m.away?.teamId ?? m.away?.team?.id;
    const homePts = Number(m.home?.totalPoints ?? m.home?.points ?? m.home?.total ?? NaN);
    const awayPts = Number(m.away?.totalPoints ?? m.away?.points ?? m.away?.total ?? NaN);
    if (Number.isFinite(homePts) && homeId != null) byTeam.set(Number(homeId), homePts);
    if (Number.isFinite(awayPts) && awayId != null) byTeam.set(Number(awayId), awayPts);
  }
  return byTeam;
}
// Tries several ESPN views for a given week and returns Map<teamId, weekPoints>
async function fetchWeekPoints({ leagueId, season, week, headers = {} }) {
  const views = ["mSchedule", "mMatchupScore", "mBoxscore"]; // reliability order
  let lastErr;

  for (const view of views) {
    const url =
      `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${encodeURIComponent(season)}` +
      `/segments/0/leagues/${encodeURIComponent(leagueId)}?scoringPeriodId=${encodeURIComponent(week)}&view=${encodeURIComponent(view)}`;

    try {
      const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status} for view ${view}`); continue; }

      const json = await res.json();
      const schedule = Array.isArray(json?.schedule) ? json.schedule : [];

      // Build a points map from the schedule rows
      const map = new Map();
      for (const m of schedule) {
        const sides = ["home", "away"];
        for (const side of sides) {
          const node = m?.[side];
          if (!node) continue;

          const teamId =
            node.teamId ?? node.team?.id ?? node.team?.teamId ?? node.id ?? null;

          // Try the common fields in priority order
          const ptsRaw =
            node.totalPoints ??
            node.points ??
            node.total ??
            node.cumulativeScore ??
            node.rosterForCurrentScoringPeriod?.appliedStatTotal ??
            node.rosterForCurrentScoringPeriod?.appliedTotal ??
            null;

          if (teamId != null && Number.isFinite(Number(ptsRaw))) {
            map.set(Number(teamId), Number(ptsRaw));
          }
        }
      }

      // If we got anything, return it. Otherwise try next view.
      if (map.size > 0) return map;

      // If schedule exists but points fields aren’t present yet (early in week),
      // just return an empty map rather than throwing.
      if (schedule.length > 0) return map;

      // Try next view
    } catch (err) {
      lastErr = err;
      continue;
    }
  }

  // If absolutely nothing worked, bubble last error (or empty map if you prefer)
  if (lastErr) throw lastErr;
  return new Map();
}

/**
 * Main: Get standings (season totals) and optional per-week points.
 * Returns { ok:true, standings:[{teamId,wins,losses,ties,pointsFor,pointsAgainst,weekPoints?,seasonPoints}] }
 */
export async function getStandings({ leagueId, season, week, swid, s2 }) {
  if (!leagueId || !season) {
    return { ok: false, error: "Missing leagueId or season" };
  }

  // 1) Season standings via league endpoint (teams + standings)
  const leagueUrl =
    `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${encodeURIComponent(season)}` +
    `/segments/0/leagues/${encodeURIComponent(leagueId)}?view=mTeam&view=mStandings`;

  const leagueJSON = await espnGetJSON(leagueUrl, { swid, s2 });
  const standings = normalizeStandingsFromLeaguePayload(leagueJSON);

  // 2) Optional per-week points via scoreboard (only if week provided)
  if (week != null) {
    const wk = Number(week);
    if (Number.isFinite(wk) && wk > 0) {
      const scoreboardUrl =
        `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${encodeURIComponent(season)}` +
        `/segments/0/leagues/${encodeURIComponent(leagueId)}?scoringPeriodId=${encodeURIComponent(wk)}&view=mMatchupScore`;

      const scoreboardJSON = await espnGetJSON(scoreboardUrl, { swid, s2 });
      const weekMap = buildWeekPointsMap(scoreboardJSON);

      for (const row of standings) {
        const wp = weekMap.get(row.teamId);
        if (Number.isFinite(wp)) row.weekPoints = Number(wp);
      }
    }
  }

  // 3) seasonPoints alias (PF) to support your scope switcher
  for (const row of standings) {
    row.seasonPoints = row.pointsFor;
  }

  return { ok: true, standings };
}

export default { getStandings };
