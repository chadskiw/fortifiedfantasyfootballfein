// GET /fein-auth/by-league?leagueId=...&season=2025
app.get('/fein-auth/by-league', async (req, res) => {
  try {
    const leagueIdRaw = (req.query.leagueId ?? '').toString().trim();
    const seasonRaw   = (req.query.season   ?? '').toString().trim();
    if (!leagueIdRaw || !seasonRaw) return bad(res, 400, 'leagueId, season required');

    const leagueId = BigInt(leagueIdRaw).toString();
    const season   = Number(seasonRaw);

    const q = `
      select league_id, team_id, season, name, handle, league_size
      from public.fein_teams
      where league_id = $1::bigint and season = $2::int
      order by team_id
      limit 100
    `;
    const { rows } = await pool.query(q, [leagueId, season]);
    ok(res, { rows });
  } catch (e) { bad(res, 500, String(e)); }
});
