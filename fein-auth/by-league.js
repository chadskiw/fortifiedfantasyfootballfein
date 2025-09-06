// src/fein-auth/by-league.js
const { Router } = require("express");
const { query } = require("../lib/db"); // adjust path if your db helper differs

const router = Router();

router.options("/", (_req, res) => res.sendStatus(204));

router.get("/", async (req, res) => {
  try {
    const season   = (req.query.season ?? "").toString().trim();
    const leagueId = (req.query.leagueId ?? "").toString().trim();

    let rows = [];
    if (leagueId) {
      rows = await query(
        `SELECT DISTINCT league_id, season::int, league_size,
                MAX(name)   AS name,
                MAX(handle) AS handle
           FROM fein_teams
          WHERE league_id = $1
          GROUP BY league_id, season, league_size
          ORDER BY season DESC`,
        [leagueId]
      );
    } else if (season) {
      rows = await query(
        `SELECT DISTINCT league_id, season::int, league_size,
                MAX(name)   AS name,
                MAX(handle) AS handle
           FROM fein_teams
          WHERE season = $1
          GROUP BY league_id, season, league_size
          ORDER BY name NULLS LAST, league_id`,
        [season]
      );
    } else {
      rows = await query(
        `SELECT DISTINCT league_id, season::int, league_size,
                MAX(name)   AS name,
                MAX(handle) AS handle
           FROM fein_teams
          GROUP BY league_id, season, league_size
          ORDER BY season DESC, name NULLS LAST, league_id`
      );
    }

    res.json({ ok: true, count: rows.length, leagues: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: "by-league failed", detail: String(err) });
  }
});

module.exports = router;
