# FEIN Meta & Duel v3 — server + client

This drop includes **(1) the CommonJS Player Meta router** with `require` and **(2) the Duel HTML (v3)** wired to consume `ECR`, `DVP`, `BYE`, and `FMV` from the new meta endpoint. Paste the router into your server (e.g., `routes/playerMeta.js`), mount it, and open the HTML.

---

## 1) `routes/playerMeta.js` — CommonJS router (require)

```js
/**
 * Player Meta API — CommonJS (require) + Express Router
 * Enriches ESPN pid with: proj (from your roster), bye week, ECR, DVP, FMV, opponent, bio, news.
 *
 * Mount:
 *   const meta = require('./routes/playerMeta');
 *   app.use('/api', meta);
 *
 * Node 18+ (global fetch). Optional Redis via REDIS_URL.
 */

const express = require('express');
const router = express.Router();

// Optional Redis
let redis = null;
try { if (process.env.REDIS_URL) { const Redis = require('ioredis'); redis = new Redis(process.env.REDIS_URL, { lazyConnect: true }); } } catch {}

// Config
const FF_BASE = process.env.FF_BASE || 'https://fortifiedfantasy.com';
const MEM_TTL_MS = 12 * 60 * 1000; // 12m
const REDIS_TTL_SEC = 15 * 60;     // 15m

// Memory cache
const mem = new Map();
function mget(key){ const v = mem.get(key); if(!v) return null; if(Date.now()>v.exp){ mem.delete(key); return null; } return v.val; }
function mset(key,val,ttl=MEM_TTL_MS){ mem.set(key,{exp:Date.now()+ttl,val}); }
async function rget(key){ if(!redis) return null; try{ if(!redis.status||redis.status==='end') await redis.connect(); return await redis.get(key);}catch{ return null; } }
async function rset(key,val,ttl=REDIS_TTL_SEC){ if(!redis) return; try{ if(!redis.status||redis.status==='end') await redis.connect(); await redis.set(key,val,'EX',ttl);}catch{} }

// Utils
function headshotUrl(pid){ return `https://a.espncdn.com/i/headshots/nfl/players/full/${pid}.png`; }
function isDigits(s){ return typeof s==='string' && /^\d+$/.test(s); }
async function getJSON(url, timeoutMs = 1700){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'ff-meta/1.1 (+fortifiedfantasy.com)' } });
    if(!r.ok) throw new Error(String(r.status));
    return await r.json();
  } finally{ clearTimeout(t); }
}
function mergeMeta(base, add){
  if(!add) return base; const out = { ...base };
  for(const k of Object.keys(add)){
    const v = add[k]; if(v==null) continue;
    if(Array.isArray(v)){ out[k] = (Array.isArray(out[k]) && out[k].length) ? out[k] : v; }
    else if(typeof v==='object'){ out[k] = mergeMeta(out[k]||{}, v); }
    else if(out[k]==null){ out[k] = v; }
  }
  return out;
}

// Sources — roster (proj), athlete (bio), news
async function fromRoster(ctx, pid){
  const { season, week, leagueId, teamId } = ctx; if(!(season && leagueId && teamId)) return null;
  const scopeWeek = week ? `week&week=${week}` : 'season';
  const urls = [
    `${FF_BASE}/api/platforms/espn/roster?season=${season}&leagueId=${leagueId}&teamId=${teamId}&scope=${scopeWeek}`,
    `${FF_BASE}/api/platforms/espn/roster?season=${season}&leagueId=${leagueId}&teamId=${teamId}&scope=season`
  ];
  for(const u of urls){
    try{ const j = await getJSON(u, 1800); const list = Array.isArray(j && j.players)? j.players:[]; const p = list.find(x=>String(x.playerId)===String(pid));
      if(p){ return { id:String(p.playerId), name:p.name, position:p.position, team:{abbr:p.teamAbbr}, headshot:p.headshot||headshotUrl(String(p.playerId)), fantasy:{ proj:Number(p.proj)||0, source:'espn-roster', lineupSlotId:Number(p.lineupSlotId)||null }, teamContext:{ isStarter:!!p.isStarter, lineupSlotId:Number(p.lineupSlotId)||null } }; }
    }catch{}
  }
  return null;
}
async function fromEspnAthlete(pid){
  const url = `https://site.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${pid}`;
  try{ const j = await getJSON(url, 1800); const a = (j && j.athlete) ? j.athlete : j; if(!a) return null;
    const team = a.team || a.collegeTeam || a.proTeam || {}; const injury = (a.injuries && a.injuries[0]) || a.defaultInjury || {};
    const expYears = (a.experience && a.experience.years) || a.experience;
    return {
      id:String(a.id||pid), name:a.fullName||a.displayName, firstName:a.firstName, lastName:a.lastName,
      jersey:a.jersey, position:(a.position && (a.position.abbreviation||a.position.displayName))||a.position,
      team:{ id: a.teamId?String(a.teamId): (team.id?String(team.id):undefined), abbr: team.abbreviation, name: team.displayName||team.name },
      headshot:(a.headshot && a.headshot.href) || headshotUrl(pid),
      physical:{ heightIn:a.height?Number(a.height):undefined, weightLb:a.weight?Number(a.weight):undefined, age:a.age, birthDate:a.dateOfBirth },
      experience:{ years:expYears?Number(expYears):undefined, display:a.experience && a.experience.displayValue },
      college:(a.college && a.college.name) || a.college,
      draft: a.draft ? { year:a.draft.year, round:a.draft.round, pick:a.draft.selection, team:a.draft.team && a.draft.team.abbreviation } : undefined,
      status:{ active:a.active, rosterStatus:(a.status && a.status.type) || a.status },
      injury: (injury && (injury.status||injury.details||injury.description)) ? { status:injury.status, description:injury.details||injury.description, date:injury.date } : undefined,
    };
  }catch{ return null; }
}
async function fromEspnNews(pid){
  const urls=[
    `https://site.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${pid}/news`,
    `https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=5&aggregated=true&players=${pid}`
  ];
  for(const u of urls){ try{ const j=await getJSON(u,1500); const items=(j && (j.news||j.articles||j.items))||[]; if(items.length){ return items.slice(0,5).map(n=>({ headline:n.headline||n.title, description:n.description||n.blurb, published:n.published||n.lastModified||n.date, link:(n.links && n.links.web && n.links.web.href)||n.link||n.url, source:n.source||'ESPN' })); } }catch{} }
  return [];
}

// Optional sources: ECR, DVP, Bye, FMV, Next Opp
async function fromECR(ctx, pid, pos){
  const { season } = ctx; if(!season) return null;
  const tries = [
    `${FF_BASE}/api/consensus/ecr?season=${season}&pid=${pid}`,
    `${FF_BASE}/api/consensus/ecr?season=${season}&pos=${encodeURIComponent(pos||'')}`,
    `${FF_BASE}/api/aggregates/ecr?season=${season}&pid=${pid}`,
    `${FF_BASE}/api/ranks/ecr?season=${season}&pid=${pid}`
  ];
  for(const u of tries){ try{ const j=await getJSON(u,1500); if(j && (j.rank||j.overall||j.posRank)) return { overall:j.overall||j.rank||null, posRank:j.posRank||j.positionRank||null, source:j.source||'ff-ecr' }; if(j && Array.isArray(j.players)){ const p=j.players.find(x=>String(x.playerId||x.id)===String(pid)); if(p) return { overall:p.overall||p.rank||null, posRank:p.posRank||p.positionRank||null, source:j.source||'ff-ecr' }; } }catch{} }
  return null;
}
async function fromDVP(ctx, pos, oppAbbr){
  const { season, week } = ctx; if(!season || !pos) return null;
  const tries=[
    `${FF_BASE}/api/metrics/dvp?season=${season}&pos=${encodeURIComponent(pos)}${week?`&week=${week}`:''}`,
    `${FF_BASE}/api/dvp?season=${season}&pos=${encodeURIComponent(pos)}${week?`&week=${week}`:''}`
  ];
  for(const u of tries){ try{ const j=await getJSON(u,1500); const table = j && (j.data||j.ranks||j.teams||j); if(table && typeof table==='object'){ const norm=Array.isArray(table)?table:Object.values(table); const entry = oppAbbr ? norm.find(x=> (x.teamAbbr||x.team||x.abbr)===oppAbbr) : null; const asRank = (x)=> Number((x&&(x.rank||x.r||x.order||x.value))||0)||null; return entry ? { pos, opp:oppAbbr, rank:asRank(entry) } : { pos, rank:null }; } }catch{} }
  return null;
}
async function fromByeWeek(ctx, teamAbbr){
  const { season } = ctx; if(!season || !teamAbbr) return null;
  const tries=[ `${FF_BASE}/api/nfl/bye-weeks?season=${season}`, `${FF_BASE}/api/nfl/teams?season=${season}` ];
  for(const u of tries){ try{ const j=await getJSON(u,1500); if(j && typeof j==='object' && !Array.isArray(j)){ const wk = j[teamAbbr] || j[teamAbbr.toUpperCase()]; if(Number.isFinite(Number(wk))) return Number(wk); }
    const list = (j && (j.teams||j.data)) || (Array.isArray(j)?j:[]); const t = Array.isArray(list)? list.find(x=> (x.abbr||x.teamAbbr||x.code)===teamAbbr):null; if(t && Number.isFinite(Number(t.byeWeek))) return Number(t.byeWeek);
  }catch{} }
  return null;
}
function computeFmvIndex(ecrPosRank, posCount){ if(!ecrPosRank || !posCount) return null; const pct = 1 - (ecrPosRank-1)/posCount; return Math.round(pct*100); }
async function fromFMV(ctx, pid, pos, ecr){
  const { season } = ctx; if(!season) return null;
  const tries=[ `${FF_BASE}/api/market/fmv?season=${season}&pid=${pid}`, `${FF_BASE}/api/values/fmv?season=${season}&pid=${pid}` ];
  for(const u of tries){ try{ const j=await getJSON(u,1500); if(j && (j.value||j.fmv||j.amount)) return { value:Number(j.value||j.fmv||j.amount), unit:j.unit||'USD', source:j.source||'ff-fmv' }; }catch{} }
  const posTotals = { QB:32, RB:80, WR:100, TE:40, K:32, DST:32, FLEX:220 };
  const idx = computeFmvIndex(ecr && ecr.posRank, posTotals[pos]||100);
  return idx!=null ? { value: idx, unit:'index', source:'derived' } : null;
}
async function fromNextOpponent(teamIdOrAbbr){
  if(!teamIdOrAbbr) return null; const suffix = String(teamIdOrAbbr).match(/^\d+$/) ? teamIdOrAbbr : encodeURIComponent(teamIdOrAbbr);
  try{ const j = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${suffix}`, 1900);
    const evt = j && ((j.team && j.team.nextEvent && j.team.nextEvent[0]) || (j.nextEvent && j.nextEvent[0]));
    const comp = evt && evt.competitions && evt.competitions[0];
    if(comp){ const teams=(comp.competitors||[]).map(c=>({ abbr:c.team && c.team.abbreviation, id:c.team && c.team.id, home:c.homeAway==='home' }));
      if(teams.length===2){ const me=teams.find(t=> t.abbr===(j.team && j.team.abbreviation) || t.id===String(j.team && j.team.id)); const opp=teams.find(t=> t!==me); if(opp) return { oppAbbr: opp.abbr, oppTeamId: opp.id }; }
    }
  }catch{}
  return null;
}

// Build meta
async function buildMeta({ pid, season, week, leagueId, teamId }){
  const key = `pm:v2:${pid}:${season||'x'}:${week||'x'}:${leagueId||'x'}:${teamId||'x'}`;
  const cached = mget(key) || (await (async()=>{ const s = await rget(key); return s ? JSON.parse(s) : null; })());
  if(cached) return cached;

  const ctx = { pid, season, week, leagueId, teamId };
  const sources = {};
  let meta = { id: String(pid), headshot: headshotUrl(pid) };

  const roster = await fromRoster(ctx, pid); if(roster){ sources.roster=true; meta = mergeMeta(roster, meta); }
  const athlete = await fromEspnAthlete(pid); if(athlete){ sources.espnAthlete=true; meta = mergeMeta(meta, athlete); }
  const nextOpp = await fromNextOpponent(meta.team && (meta.team.id || meta.team.abbr)); if(nextOpp){ meta = mergeMeta(meta, nextOpp); }
  const ecr = await fromECR(ctx, pid, meta.position); if(ecr){ sources.ecr=true; meta.fantasy = Object.assign({}, meta.fantasy, { ecr }); }
  const dvp = await fromDVP(ctx, meta.position, meta.oppAbbr); if(dvp){ sources.dvp=true; meta.fantasy = Object.assign({}, meta.fantasy, { dvp }); }
  const byeWeek = await fromByeWeek(ctx, meta.team && meta.team.abbr); if(byeWeek!=null){ sources.byeWeek=true; meta.byeWeek = byeWeek; }
  const fmv = await fromFMV(ctx, pid, meta.position, ecr); if(fmv){ sources.fmv=true; meta.fantasy = Object.assign({}, meta.fantasy, { fmv }); }
  const news = await fromEspnNews(pid); if(news && news.length){ sources.espnNews=true; meta.news = news; }

  const payload = { ok:true, pid:String(pid), season, week, meta, sources };
  mset(key, payload); rset(key, JSON.stringify(payload)).catch(()=>{});
  return payload;
}

// Routes
router.get('/player/meta', async (req, res)=>{
  try{
    const pid = String(req.query.pid||''); if(!isDigits(pid)) return res.status(400).json({ ok:false, error:'pid required (digits)' });
    const season   = req.query.season ? Number(req.query.season) : undefined;
    const week     = req.query.week   ? Number(req.query.week)   : undefined;
    const leagueId = req.query.leagueId ? Number(req.query.leagueId) : undefined;
    const teamId   = req.query.teamId   ? Number(req.query.teamId)   : undefined;
    const out = await buildMeta({ pid, season, week, leagueId, teamId });
    res.json(out);
  }catch(err){ console.error('meta error', err); res.status(500).json({ ok:false, error:'internal' }); }
});

router.get('/player/meta/batch', async (req, res)=>{
  try{
    const ids = String(req.query.pid||'').split(',').map(s=>s.trim()).filter(isDigits);
    if(!ids.length) return res.status(400).json({ ok:false, error:'pid comma-list required' });
    const season   = req.query.season ? Number(req.query.season) : undefined;
    const week     = req.query.week   ? Number(req.query.week)   : undefined;
    const leagueId = req.query.leagueId ? Number(req.query.leagueId) : undefined;
    const teamId   = req.query.teamId   ? Number(req.query.teamId)   : undefined;

    const ctx = { season, week, leagueId, teamId };
    const out = {};
    await Promise.all(ids.map(async pid=>{ out[pid] = await buildMeta({ pid, ...ctx }); }));
    res.json({ ok:true, data: out });
  }catch(err){ console.error('meta batch error', err); res.status(500).json({ ok:false, error:'internal' }); }
});

module.exports = router;


