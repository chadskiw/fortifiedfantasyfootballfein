// src/platforms/espn.js
const fetch = global.fetch || ((...a) => import('node-fetch').then(({default:f}) => f(...a)));

module.exports = {
  name: 'espn',

  async leagues({ season, auth }) {
    const { swid, s2 } = auth || {};
    if (!swid || !s2) throw new Error('Missing ESPN auth');
    // TODO: call your existing ESPN league list and normalize:
    // return [{ leagueId:'123', name:'My League', size:12 }, ...]
    return [];
  },

  async teams({ leagueId, season, auth }) {
    const { swid, s2 } = auth || {};
    if (!swid || !s2) throw new Error('Missing ESPN auth');
    // TODO: return [{ teamId:'7', teamName:'Dubsauce', owner:'Chad', logo: '...' }, ...]
    return [];
  },

  async roster({ leagueId, teamId, season, week, auth }) {
    const { swid, s2 } = auth || {};
    if (!swid || !s2) throw new Error('Missing ESPN auth');
    // TODO: return [{ playerId, name, pos, nfl, weekPts, seasonPts, ... }, ...]
    return [];
  },

  async freeAgents({ leagueId, season, week, auth }) {
    const { swid, s2 } = auth || {};
    if (!swid || !s2) throw new Error('Missing ESPN auth');
    // TODO
    return [];
  }
};
