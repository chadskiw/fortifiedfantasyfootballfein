// TRUE_LOCATION: src/api/sleeper.js
// IN_USE: FALSE
// src/platforms/sleeper.js
const fetch = global.fetch || ((...a) => import('node-fetch').then(({default:f}) => f(...a)));

module.exports = {
  name: 'sleeper',

  async leagues({ season, auth }) {
    // If you have a mapping from your user -> sleeperUserId
    // GET https://api.sleeper.app/v1/user/{userId}/leagues/nfl/{season}
    return [];
  },

  async teams({ leagueId }) {
    // GET https://api.sleeper.app/v1/league/{leagueId}/rosters
    // + https://api.sleeper.app/v1/league/{leagueId}/users (to map owner display names)
    return [];
  },

  async roster({ leagueId, teamId, season, week }) {
    return [];
  },

  async freeAgents({ leagueId, season, week }) {
    return [];
  }
};
