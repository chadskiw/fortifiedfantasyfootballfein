const { Router } = require("express");
const { query } = require("../lib/db");

const router = Router();

router.options("/", (_req, res) => res.sendStatus(204));

router.get("/", async (req, res) => {
  try {
    const seasonQ  = (req.query.season   ?? "").toString().trim();
    const leagueId = (req.query.leagueId ?? "").toString().trim();
    const sizeStr  = (req.query.size     ?? req.query.leagueSize ?? "").toString().trim();

    const season = seasonQ ? Number(seasonQ) : null;
    const size   = sizeStr ? Number(sizeStr) : null;
    const hasSeason = Number.isInteger(season);
    const hasSize   = Number.isInteger(size) && size > 0;

    const where = [];
    const params = [];

    if (hasSeason) {
      params.push(season);
      where.push(`season::int = $${params.length}`);
    }
    if (hasSize) {
      params.push(size);
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

    // extra safety: post-filter
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
