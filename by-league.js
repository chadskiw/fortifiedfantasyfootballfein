// PUBLIC: list leagues (optionally filter by season, leagueId, and size)
// GET /api/fein-auth/by-league?season=2025
// GET /api/fein-auth/by-league?season=2025&size=12
// GET /api/fein-auth/by-league?leagueId=1888700373
// GET /api/fein-auth/by-league?leagueId=1888700373&size=12

const { Router } = require("express");
const { query } = require("../lib/db");

const router = Router();

router.options("/", (_req, res) => res.sendStatus(204));

router.get("/", async (req, res) => {
  try {
    const season   = (req.query.season   ?? "").toString().trim();
    const leagueId = (req.query.leagueId ?? "").toString().trim();
    const sizeStr  = (req.query.size     ?? req.query.leagueSize ?? "").toString().trim();

    // Parse size if present
    const size = Number(sizeStr);
    const hasSize = Number.isInteger(size) && size > 0;

    // Build WHERE + params dynamically
    const where = [];
    const params = [];

    if (leagueId) {
      params.push(leagueId);
      where.push(`league_id = $${params.length}`);
    }
    if (season) {
      params.push(season);
      where.push(`season = $${params.length}`);
    }
    if (hasSize) {
      params.push(size);
      where.push(`league_size = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // We collapse team rows into one league row per (league_id, season, league_size)
    const rows = await query(
      `SELECT DISTINCT league_id,
              season::int AS season,
              league_size::int AS league_size,
              MAX(name)   AS name,
              MAX(handle) AS handle
         FROM fein_teams
        ${whereSql}
        GROUP BY league_id, season, league_size
        ORDER BY season DESC, name NULLS LAST, league_id`
      , params
    );

    res.json({
      ok: true,
      filters: {
        season: season || null,
        leagueId: leagueId || null,
        size: hasSize ? size : null
      },
      count: rows.length,
      leagues: rows
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "by-league failed", detail: String(err) });
  }
});

module.exports = router;
