/* functions/api/pole-position.js
   GET /api/pole-position?season=2025&leagueId=...&scope=week|season&week=5&scoring=PPR
   Returns: { ok:true, meta:{...}, rows:[ {rank, teamId, teamName, points, week, scoring, team_hex, owner_handle, avatar_url} ] }
*/
import { json } from '../_utils/json.js';         // ↳ your existing helper (or swap for res.json)
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgresql://chad:Happylife82@dpg-cv0bnppopnds73b7dpr0-a.ohio-postgres.render.com:5432/fortifiedfantasy",
  max: 5
});

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return res.status(204).end();

    const season   = Number(req.query.season || req.headers['x-ff-season']);
    const leagueId = String(req.query.leagueId || req.headers['x-ff-leagueid'] || '');
    const scope    = (req.query.scope || 'week').toString().toLowerCase(); // 'week' | 'season'
    const scoring  = (req.query.scoring || 'PPR').toString().toUpperCase(); // 'STD'|'HALF'|'PPR'
    const weekRaw  = req.query.week ? Number(req.query.week) : null;

    if (!season || !leagueId) {
      return json(res, { ok:false, error:'season and leagueId required' }, 400);
    }

    const client = await pool.connect();
    try {
      // Pick week (explicit, or latest available in cache)
      const { rows: wrows } = await client.query(
        `
        SELECT COALESCE($1::int, MAX(week)) AS target_week
        FROM ff_team_points_cache
        WHERE season=$2 AND league_id=$3 AND scoring=$4
        `,
        [weekRaw, season, leagueId, scoring]
      );
      const targetWeek = wrows[0]?.target_week || weekRaw || 1;

      // Select points
      //  - scope=week   → use week_pts
      //  - scope=season → use season_pts (as-of targetWeek)
      const { rows } = await client.query(
        `
        WITH base AS (
          SELECT
            c.team_id,
            MAX(c.team_name)    AS team_name,
            MAX(c.week)         AS week,
            MAX(c.scoring)      AS scoring,
            -- pull meta from ff_sport_ffl if present (safe COALESCEs)
            COALESCE(MAX(f.owner_handle), '')    AS owner_handle,
            COALESCE(MAX(f.team_hex),     '#888') AS team_hex,
            COALESCE(MAX(f.avatar_url),   '')     AS avatar_url,
            -- choose points column based on scope
            ${scope === 'season' ? 'MAX(c.season_pts)' : 'MAX(c.week_pts)'} AS points
          FROM ff_team_points_cache c
          LEFT JOIN ff_sport_ffl f
            ON f.season=c.season AND f.league_id=c.league_id AND f.team_id=c.team_id
          WHERE c.season=$1 AND c.league_id=$2 AND c.scoring=$3 AND c.week=$4
          GROUP BY c.team_id
        )
        SELECT *
        FROM base
        ORDER BY points DESC NULLS LAST, team_name ASC
        `,
        [season, leagueId, scoring, targetWeek]
      );

      // Rank and format
      const out = rows.map((r, i) => ({
        rank: i + 1,
        teamId: r.team_id,
        teamName: r.team_name,
        points: Number(r.points || 0).toFixed(2),
        week: r.week,
        scoring: r.scoring,
        owner_handle: r.owner_handle || null,
        team_hex: r.team_hex || null,
        avatar_url: r.avatar_url || null,
      }));

      return json(res, {
        ok: true,
        meta: { season, leagueId, week: Number(targetWeek), scoring, scope },
        rows: out
      });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[pole-position] error', e);
    return json(res, { ok:false, error:String(e?.message || e) }, 500);
  }
}

// ---------- Express wiring (if you’re on Render server.js) ----------
// import handler from './functions/api/pole-position.js';
// app.get('/api/pole-position', handler);
