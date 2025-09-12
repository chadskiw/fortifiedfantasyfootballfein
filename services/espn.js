// Placeholder adapters for your existing ESPN project.
// Wire these to your internal endpoints that already handle SWID/espn_s2.
import { jget } from '../utils/http.js';

export const espnSvc = {
  // Example: upstream = your ESPN service origin (env or hard-coded)
  upstream: process.env.ESPN_SERVICE_ORIGIN || 'http://localhost:5055',

  async leagueTeams({ leagueId, season }) {
    return jget(`${this.upstream}/api/espn/league/teams?leagueId=${encodeURIComponent(leagueId)}&season=${encodeURIComponent(season)}`, { credentials: 'include' });
  },

  async roster({ leagueId, teamId, season }) {
    return jget(`${this.upstream}/api/espn/roster?leagueId=${encodeURIComponent(leagueId)}&teamId=${encodeURIComponent(teamId)}&season=${encodeURIComponent(season)}`, { credentials: 'include' });
  },

  async draftBoard({ leagueId, season }) {
    return jget(`${this.upstream}/api/espn/draft-board?leagueId=${encodeURIComponent(leagueId)}&season=${encodeURIComponent(season)}`, { credentials: 'include' });
  }
};
