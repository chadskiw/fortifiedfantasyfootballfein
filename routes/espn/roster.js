// TRUE_LOCATION: routes/espn/roster.js
// Shared ESPN roster fetcher used by routes/espn/index.js

const PLACEHOLDER = 'https://img.fortifiedfantasy.com/avatars/default.png';
const DEFAULT_TIMEOUT_MS = 6500;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}


 function mysticGuard(url) {
   const u = String(url || '');
   return /\bmystique\b|\bsec-trc\b|\bcdn-ak-espn\b/i.test(u);
 }

 async function safeFetch(url, opt={}, { retries=1, timeout=DEFAULT_TIMEOUT_MS } = {}) {
  // allow mystique/espn asset hosts to go through so upstream failures surface
  // if you ever want to re-enable the guard, set process.env.MYSTIQUE_GUARD='1'
  if (process.env.MYSTIQUE_GUARD === '1' && mysticGuard(url)) {
    return { ok:false, status:0, blocked:true };
  }
   for (let i=0; i<=retries; i++) {
     try {
       const res = await withTimeout(fetch(url, opt), timeout);
      // do not “catch” upstream errors; hand raw response back to caller
      return { ok:res.ok, status:res.status, res };
     } catch (e) {
       if (i < retries) await sleep(250 + 250*i);
       else return { ok:false, status:0, error:e?.message || 'fetch_failed' };
     }
   }
   return { ok:false, status:0, error:'unknown' };
 }


function posName(id){
  switch(Number(id)){ case 1:return 'QB'; case 2:return 'RB'; case 3:return 'WR'; case 4:return 'TE'; case 5:return 'K'; case 16:return 'DST'; default:return 'FLEX'; }
}
function teamAbbr(proTeamId){
  const MAP = {1:"ATL",2:"BUF",3:"CHI",4:"CIN",5:"CLE",6:"DAL",7:"DEN",8:"DET",9:"GB",10:"TEN",11:"IND",12:"KC",13:"LV",14:"LAR",15:"MIA",16:"MIN",17:"NE",18:"NO",19:"NYG",20:"NYJ",21:"PHI",22:"ARI",23:"PIT",24:"LAC",25:"SF",26:"SEA",27:"TB",28:"WSH",29:"CAR",30:"JAX",33:"BAL",34:"HOU"};
  return MAP[Number(proTeamId)] || '';
}

async function getEspnRoster({ season, leagueId, teamId, week, scope='season', swid, s2 }) {
  const upstreamUrl = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mRoster`;

  const headers = {};
  const cookies = [];
  if (swid) cookies.push(`SWID=${swid}`);
  if (s2)   cookies.push(`espn_s2=${s2}`);
  if (cookies.length) headers['Cookie'] = cookies.join('; ');

  const r = await safeFetch(upstreamUrl, { headers }, { retries:1, timeout:DEFAULT_TIMEOUT_MS });

if (!r.ok) {
  // Treat 502s and similar as safe empty payloads
  if (r.status === 502 || r.status === 503 || r.status === 504) {
    console.warn(`[espn/roster] upstream ${r.status} → returning empty roster`);
    return {
      ok: true,
      soft: true,
      source: 'espn.v3',
      platform: 'espn',
      leagueId, season, week, teamId,
      players: [],
    };
  }

  // all other errors: structured soft fail
  return {
    ok: false,
    soft: true,
    code: r.blocked ? 'UPSTREAM_BLOCKED' : 'UPSTREAM_ERROR',
    status: r.status || 0,
    platform: 'espn',
    leagueId, season, week, teamId,
    players: [],
  };
}


  let data;
  try { data = await r.res.json(); } catch { data = null; }
  if (!data) return { ok:false, soft:true, code:'PARSE_ERROR', players:[] };

  const allTeams = Array.isArray(data.teams) ? data.teams : [];
  const target   = teamId ? allTeams.filter(t => String(t.id) === String(teamId)) : allTeams;

  if (!target.length) return { ok:true, players:[] };

  const t = target[0];
  const entries = (((t.roster || {}).entries) || []);
  const players = entries.map(e => {
    const p = e.playerPoolEntry?.player || e.player || {};
    return {
      id: p.id,
      name: p.fullName || p.name || 'Unknown',
      position: posName(p.defaultPositionId),
      teamAbbr: teamAbbr(p.proTeamId),
      headshot: (p?.headshot?.href) || PLACEHOLDER,
    };
  });

  return { ok:true, players, source:'espn.v3', leagueId, season, teamId, week, scope };
}

module.exports = { getEspnRoster };
