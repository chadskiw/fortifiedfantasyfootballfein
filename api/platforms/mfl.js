CHECK THIS OUT
// TRUE_LOCATION: api/platforms/mfl.js
// IN_USE: FALSE
// src/platforms/mfl.js
module.exports = {
  name: 'mfl',
  async leagues({ season, auth }) { return []; },
  async teams({ leagueId, season, auth }) { return []; },
  async roster({ leagueId, teamId, season, week, auth }) { return []; },
  async freeAgents({ leagueId, season, week, auth }) { return []; }
};
