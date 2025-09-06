// PUBLIC: list leagues (filter by season, leagueId, and size)
// Examples:
//   /api/fein-auth/by-league?season=2025
//   /api/fein-auth/by-league?season=2025&size=12
//   /api/fein-auth/by-league?leagueId=1888700373
//   /api/fein-auth/by-league?leagueId=1888700373&size=12

const { Router } = require("express");
const { query } = require("../lib/db");

const router = Router();

router.options("/", (_req, res) => res.sendStatus(204));

router.get("/", async (req, res) => {
  try {
    const seasonQ  = (req.query.season   ?? "").toString().trim();
    const leagueId = (req.query.leagueId ?? "").toString().trim();
    const sizeStr  = (req.query.size     ?? req.query.leagueSize ?? "").toString().trim();

    // Normalize inputs
    const season = seasonQ ? Number(seasonQ) : null;
    const size   = sizeStr ? Number(sizeStr) : null;
    const hasSeason = Number.isInteger(season);
    const hasSize   = Number.isInteger(size) && size > 0;

    // WHERE builder with explicit casts to be safe
    const where = [];
    const params = [];

    if (leagueId) {
      params.push(leagueId);
      where.push(`league_id = $${params.length}`);
    }
    if (hasSeason) {
      params.push(season);
      // season stored as int or text — cast either way
      where.push(`season::int = $${params.length}`);
    }
    if (hasSize) {
      params.push(size);
      // enforce size with explicit cast
      where.push(`league_size::int = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await query(
      `SELECT
         league_id,
         season::int      AS season,
         league_size::int AS league_size,
         MAX(name)        AS name,
         MAX(handle)      AS handle
       FROM fein_teams
       ${whereSql}
       GROUP BY league_id, season, league_size
       ORDER BY season DESC, name NULLS LAST, league_id`,
      params
    );

    // Defensive post-filter (in case DB types are funky or an old view is used)
    const filtered = hasSize ? rows.filter(r => Number(r.league_size) === size) : rows;

    res.json({
      ok: true,
      filters: {
        season: hasSeason ? season : null,
        leagueId: leagueId || null,
        size: hasSize ? size : null
      },
      count: filtered.length,
      leagues: filtered
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "by-league failed", detail: String(err) });
  }
});

module.exports = router;
