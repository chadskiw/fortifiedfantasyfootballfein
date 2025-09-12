// Public route: anyone can list leagues (no auth required)
// GET /api/fein-auth/by-league?season=2025
// Optional: ?leagueId=1888700373 to fetch one

import { query } from '../../../lib/db.js'; // adjust if your db helper differs

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // public CORS
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
      ...extra,
    },
  });
}

// Minimal OPTIONS handler for CORS preflights
export const onRequestOptions = async () => json({}, 204);

export const onRequestGet = async ({ request }) => {
  
  try {
    const u = new URL(request.url);
    const season   = u.searchParams.get('season') || '';
    const leagueId = u.searchParams.get('leagueId');

    // If you keep leagues in a table named `leagues`:
    // columns (example): id, league_id, season, name, owner, size, created_at
    // Adjust to your schema.
    let rows;
    if (leagueId) {
      rows = await query(
        `SELECT league_id AS "leagueId",
                season::int      AS season,
                COALESCE(name,'')   AS name,
                COALESCE(owner,'')  AS owner,
                COALESCE(size, NULL)::int AS size
           FROM leagues
          WHERE league_id = $1`,
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

    return json({ ok: true, count: rows.length, leagues: rows });
  } catch (err) {
    // If DB isn’t wired yet, fail gracefully but keep the route public.
    return json({ ok: false, error: 'by-league failed', detail: String(err) }, 500);
  }
};
