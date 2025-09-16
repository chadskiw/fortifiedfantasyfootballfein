// server/lib/fein.js
import { pool } from './db.js';

export async function getFeinTeam({ leagueId, teamId, season }) {
  const q = `
    SELECT league_id, team_id, season, name, handle,
           fb_groups, league_size, swid, espn_s2
    FROM public.fein_teams
    WHERE league_id = $1 AND team_id = $2 AND season = $3
    LIMIT 1
  `;
  const { rows } = await pool.query(q, [leagueId, teamId, season]);
  return rows[0] || null;
}
