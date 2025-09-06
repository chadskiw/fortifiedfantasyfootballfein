// PUBLIC endpoint — anyone can view leagues
const { Router } = require("express");
const { query } = require("../lib/db");

const router = Router();

router.options("/", (_req, res) => res.sendStatus(204));

router.get("/", async (req, res) => {
  try {
    const season   = (req.query.season ?? "").toString().trim();
    const leagueId = (req.query.leagueId ?? "").toString().trim();

    let rows = [];
    if (leagueId) {
      rows = await query(
        `SELECT league_id AS "leagueId",
                season::int      AS season,
                COALESCE(name,'')   AS name,
                COALESCE(owner,'')  AS owner,
                COALESCE(size, NULL)::int AS size
           FROM leagues
          WHERE league_id = $1
          ORDER BY season DESC`,
        [leagueId]
      );
    } else if (season) {
      rows = await query(
        `SELECT league_id AS "leagueId",
                season::int      AS season,
                COALESCE(name,'')   AS name,
                COALESCE(owner,'')  AS owner,
                COALESCE(size, NULL)::int AS size
           FROM leagues
          WHERE season = $1
          ORDER BY name NULLS LAST, league_id`,
        [season]
      );
    } else {
      rows = await query(
        `SELECT league_id AS "leagueId",
                season::int      AS season,
                COALESCE(name,'')   AS name,
                COALESCE(owner,'')  AS owner,
                COALESCE(size, NULL)::int AS size
           FROM leagues
          ORDER BY season DESC, name NULLS LAST, league_id`
      );
    }

    res.json({ ok: true, count: rows.length, leagues: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: "by-league failed", detail: String(err) });
  }
});

module.exports = router;
