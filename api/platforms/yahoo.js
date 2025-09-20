CHECK THIS OUT
// TRUE_LOCATION: api/platforms/yahoo.js
// IN_USE: FALSE
// src/platforms/yahoo.js
module.exports = {
  name: 'yahoo',
  async leagues({ season, auth }) { return []; },
  async teams({ leagueId, season, auth }) { return []; },
  async roster({ leagueId, teamId, season, week, auth }) { return []; },
  async freeAgents({ leagueId, season, week, auth }) { return []; }
};
