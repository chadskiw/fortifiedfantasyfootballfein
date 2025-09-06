app.get('/fein-auth', async (req, res) => {
  try {
    const leagueIdRaw = (req.query.leagueId ?? '').toString().trim();
    const teamIdRaw   = (req.query.teamId   ?? '').toString().trim();
    const seasonRaw   = (req.query.season   ?? '').toString().trim();

    if (!leagueIdRaw || !teamIdRaw || !seasonRaw) {
      return bad(res, 400, 'leagueId, teamId, season required');
    }

    // Coerce to numbers explicitly so they match bigint/int columns
    const leagueId = BigInt(leagueIdRaw).toString(); // stays in-range as string
    const teamId   = BigInt(teamIdRaw).toString();
    const season   = Number(seasonRaw);

    const q = `
      select league_id, team_id, season, name, handle, league_size, fb_groups, swid, espn_s2
      from public.fein_teams
      where league_id = $1::bigint and team_id = $2::bigint and season = $3::int
      limit 1
    `;
    const { rows } = await pool.query(q, [leagueId, teamId, season]);
    if (!rows.length) return bad(res, 404, 'not found');
    ok(res, rows[0]);
  } catch (e) {
    bad(res, 500, String(e));
  }
});
