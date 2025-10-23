/**
 * Player Meta API — CommonJS (require) — CLEAN ERRORS EDITION
 * ------------------------------------------------------------
 * Goal: remove try/catch sprawl. We use Promise.allSettled and a single
 * error boundary at the route layer. All source functions either resolve
 * with useful data or let rejections be handled by allSettled.
 *
 * Mount:
 *   const meta = require('./routes/playerMeta.clean');
 *   app.use('/api', meta);
 *
 * Node 18+ (global fetch + AbortController). Optional Redis via REDIS_URL.
 */

const express = require('express');
const router = express.Router();

// ---- Config ----
const FF_BASE = process.env.FF_BASE || 'https://fortifiedfantasy.com';
const DEFAULT_LEAGUE_ID = Number(process.env.FF_DEFAULT_LEAGUE_ID || 1634950747);
const TEAM_ID_MAX = Number(process.env.FF_TEAM_ID_MAX || 20);
const MEM_TTL_MS = 12 * 60 * 1000; // 12m
const REDIS_TTL_SEC = 15 * 60;     // 15m

// ---- Optional Redis ----
let redis = null;
try { if (process.env.REDIS_URL) { const Redis = require('ioredis'); redis = new Redis(process.env.REDIS_URL, { lazyConnect: true }); } } catch {}
async function rget(key){ if(!redis) return null; if(!redis.status || redis.status==='end') await redis.connect(); return await redis.get(key); }
async function rset(key,val,ttl=REDIS_TTL_SEC){ if(!redis) return; if(!redis.status || redis.status==='end') await redis.connect(); await redis.set(key,val,'EX',ttl); }

// ---- Memory cache ----
const mem = new Map();
function mget(key){ const v = mem.get(key); if(!v) return null; if(Date.now()>v.exp){ mem.delete(key); return null; } return v.val; }
function mset(key,val,ttl=MEM_TTL_MS){ mem.set(key,{exp:Date.now()+ttl,val}); }

// ---- Utilities ----
function isDigits(s){ return typeof s==='string' && /^\d+$/.test(s); }
function headshotUrl(pid){ return `https://a.espncdn.com/i/headshots/nfl/players/full/${pid}.png`; }
function mergeMeta(base, add){ if(!add) return base; const out={...base}; for(const k of Object.keys(add)){ const v=add[k]; if(v==null) continue; if(Array.isArray(v)){ out[k]=(Array.isArray(out[k])&&out[k].length)?out[k]:v; } else if(typeof v==='object'){ out[k]=mergeMeta(out[k]||{}, v); } else if(out[k]==null){ out[k]=v; } } return out; }
function parseNum(v){ const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function pick(){ for(let i=0;i<arguments.length;i++){ const v=arguments[i]; if(v!=null && v!=='') return v; } return undefined; }
function hydrateCtx(req){
  const q=req.query||{}; const h=req.headers||{};
  let season=parseNum(pick(q.season, h['x-ff-season']));
  let week=parseNum(pick(q.week, h['x-ff-week']));
  let leagueId=parseNum(pick(q.leagueId, h['x-ff-league'])) || DEFAULT_LEAGUE_ID;
  let teamId=parseNum(pick(q.teamId, h['x-ff-team']));
  const ref=req.get && req.get('referer');
  if(ref){ try{ const u=new URL(ref); season=season||parseNum(u.searchParams.get('season')); week=week||parseNum(u.searchParams.get('week')); leagueId=leagueId||parseNum(u.searchParams.get('leagueId')); teamId=teamId||parseNum(u.searchParams.get('teamId')); }catch{} }
  return { season, week, leagueId, teamId };
}

class HttpError extends Error{ constructor(status, url, body){ super(`HTTP ${status} for ${url}`); this.status=status; this.url=url; this.body=body; } }
async function fetchJson(url, timeoutMs=1700){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(), timeoutMs);
  const r=await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'ff-meta/clean/1.0 (+fortifiedfantasy.com)' } });
  clearTimeout(t);
  if(!r.ok){ throw new HttpError(r.status, url, await r.text().catch(()=>'')); }
  return await r.json();
}
async function firstFulfilled(urls, timeoutMs){
  const settled = await Promise.allSettled(urls.map(u=>fetchJson(u, timeoutMs)));
  for(const s of settled){ if(s.status==='fulfilled' && s.value) return s.value; }
  return null;
}

// Find teamId by scanning teams in a league (1..TEAM_ID_MAX); returns first match or null
async function findTeamIdInLeague({ season, week, leagueId }, pid){
  if(!(season && leagueId)) return null;
  const scopeWeek = week ? `week&week=${week}` : 'season';
  const urls = Array.from({length: TEAM_ID_MAX}, (_,i)=>{
    const tid = i+1;
    return `${FF_BASE}/api/platforms/espn/roster?season=${season}&leagueId=${leagueId}&teamId=${tid}&scope=${scopeWeek}`;
  });
  const settled = await Promise.allSettled(urls.map(u=>fetchJson(u, 1100)));
  for(let i=0;i<settled.length;i++){
    const s = settled[i];
    if(s.status==='fulfilled' && s.value && Array.isArray(s.value.players)){
      if(s.value.players.some(p=> String(p.playerId)===String(pid))) return i+1;
    }
  }
  return null;
}
  return null;
}

// ---- Sources (no local try/catch) ----
async function fromRoster(ctx, pid){
  let { season, week, leagueId, teamId } = ctx;
  if(!leagueId) leagueId = DEFAULT_LEAGUE_ID;
  if(!(season && leagueId)) return null;
  if(!teamId){
    const guessed = await findTeamIdInLeague({ season, week, leagueId }, pid);
    if(guessed) teamId = guessed; else return null;
  }
  const scopeWeek = week ? `week&week=${week}` : 'season';
  const urls=[
    `${FF_BASE}/api/platforms/espn/roster?season=${season}&leagueId=${leagueId}&teamId=${teamId}&scope=${scopeWeek}`,
    `${FF_BASE}/api/platforms/espn/roster?season=${season}&leagueId=${leagueId}&teamId=${teamId}&scope=season`
  ];
  const j = await firstFulfilled(urls, 1800); if(!j) return null;
  const list = Array.isArray(j.players) ? j.players : [];
  const p = list.find(x=>String(x.playerId)===String(pid)); if(!p) return null;
  return {
    id:String(p.playerId), name:p.name, position:p.position, team:{ abbr:p.teamAbbr },
    headshot:p.headshot || headshotUrl(String(p.playerId)),
    fantasy:{ proj:Number(p.proj)||null, source:'espn-roster', lineupSlotId:Number(p.lineupSlotId)||null },
    teamContext:{ isStarter:!!p.isStarter, lineupSlotId:Number(p.lineupSlotId)||null }
  };
}
async function fromDVP(ctx, pos, oppAbbr){
  const { season, week } = ctx; if(!season || !pos) return null;
  const j = await firstFulfilled([
    `${FF_BASE}/api/metrics/dvp?season=${season}&pos=${encodeURIComponent(pos)}${week?`&week=${week}`:''}`,
    `${FF_BASE}/api/dvp?season=${season}&pos=${encodeURIComponent(pos)}${week?`&week=${week}`:''}`
  ], 1500);
  if(!j) return null;
  const table = j.data || j.ranks || j.teams || j; const norm = Array.isArray(table)? table : Object.values(table||{});
  const entry = oppAbbr ? norm.find(x=> (x.teamAbbr||x.team||x.abbr)===oppAbbr) : null;
  const asRank = (x)=> Number((x&&(x.rank||x.r||x.order||x.value))||0)||null;
  return entry ? { pos, opp:oppAbbr, rank:asRank(entry) } : { pos, rank:null };
}
async function fromByeWeek(ctx, teamAbbr){
  const { season } = ctx; if(!season || !teamAbbr) return null;
  const j = await firstFulfilled([
    `${FF_BASE}/api/nfl/bye-weeks?season=${season}`,
    `${FF_BASE}/api/nfl/teams?season=${season}`
  ], 1500);
  if(!j) return null;
  if(!Array.isArray(j)){ const wk = j[teamAbbr] || j[teamAbbr.toUpperCase()]; if(Number.isFinite(Number(wk))) return Number(wk); }
  const list = j.teams || j.data || (Array.isArray(j)?j:[]); const t = Array.isArray(list) ? list.find(x=> (x.abbr||x.teamAbbr||x.code)===teamAbbr) : null;
  return (t && Number.isFinite(Number(t.byeWeek))) ? Number(t.byeWeek) : null;
}
function computeFmvIndex(posRank, posCount){ if(!posRank || !posCount) return null; const pct = 1 - (posRank-1)/posCount; return Math.round(pct*100); }
async function fromFMV(ctx, pid, pos, ecr){
  const { season } = ctx; if(!season) return null;
  const j = await firstFulfilled([
    `${FF_BASE}/api/market/fmv?season=${season}&pid=${pid}`,
    `${FF_BASE}/api/values/fmv?season=${season}&pid=${pid}`
  ], 1500);
  if(j && (j.value||j.fmv||j.amount)) return { value:Number(j.value||j.fmv||j.amount), unit:j.unit||'USD', source:j.source||'ff-fmv' };
  const posTotals = { QB:32, RB:80, WR:100, TE:40, K:32, DST:32, FLEX:220 };
  const idx = computeFmvIndex(ecr && ecr.posRank, posTotals[pos]||100);
  return idx!=null ? { value: idx, unit:'index', source:'derived' } : null;
}
async function fromNextOpponent(teamIdOrAbbr){
  if(!teamIdOrAbbr) return null;
  const suffix = String(teamIdOrAbbr).match(/^\d+$/) ? teamIdOrAbbr : encodeURIComponent(teamIdOrAbbr);
  const j = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${suffix}`, 1900);
  const evt = j && ((j.team && j.team.nextEvent && j.team.nextEvent[0]) || (j.nextEvent && j.nextEvent[0]));
  const comp = evt && evt.competitions && evt.competitions[0];
  if(!comp) return null;
  const teams=(comp.competitors||[]).map(c=>({ abbr:c.team && c.team.abbreviation, id:c.team && c.team.id, home:c.homeAway==='home' }));
  if(teams.length!==2) return null;
  const meAbbr = j.team && j.team.abbreviation; const meId = String(j.team && j.team.id);
  const me = teams.find(t=> t.abbr===meAbbr || t.id===meId);
  const opp = teams.find(t=> t!==me);
  return opp ? { oppAbbr: opp.abbr, oppTeamId: opp.id } : null;
}

// ---- Build meta (two phases, no local try/catch; allSettled gates errors) ----
async function buildMeta({ pid, season, week, leagueId, teamId }){
  const key = `pm:clean:v1:${pid}:${season||'x'}:${week||'x'}:${leagueId||'x'}:${teamId||'x'}`;
  const cached = mget(key) || (await (async()=>{ const s = await rget(key); return s ? JSON.parse(s) : null; })());
  if(cached) return cached;

  const ctx = { pid, season, week, leagueId, teamId };
  const sources = {};
  let meta = { id:String(pid), headshot: headshotUrl(pid) };

  // Phase 1: roster + athlete
  const phase1 = await Promise.allSettled([ fromRoster(ctx,pid), fromEspnAthlete(pid) ]);
  if(phase1[0].status==='fulfilled' && phase1[0].value){ sources.roster=true; meta = mergeMeta(phase1[0].value, meta); }
  if(phase1[1].status==='fulfilled' && phase1[1].value){ sources.espnAthlete=true; meta = mergeMeta(meta, phase1[1].value); }

  // Phase 2: enrichments that depend on team/pos/opponent
  const nextOppS = await Promise.allSettled([ fromNextOpponent(meta.team && (meta.team.id || meta.team.abbr)) ]);
  if(nextOppS[0].status==='fulfilled' && nextOppS[0].value) meta = mergeMeta(meta, nextOppS[0].value);

  const phase2 = await Promise.allSettled([
    fromECR(ctx, pid, meta.position),
    fromDVP(ctx, meta.position, meta.oppAbbr),
    fromByeWeek(ctx, meta.team && meta.team.abbr),
    fromFMV(ctx, pid, meta.position, null),
    fromEspnNews(pid)
  ]);
  if(phase2[0].status==='fulfilled' && phase2[0].value){ sources.ecr=true; meta.fantasy = Object.assign({}, meta.fantasy, { ecr: phase2[0].value }); }
  if(phase2[1].status==='fulfilled' && phase2[1].value){ sources.dvp=true; meta.fantasy = Object.assign({}, meta.fantasy, { dvp: phase2[1].value }); }
  if(phase2[2].status==='fulfilled' && phase2[2].value!=null){ sources.byeWeek=true; meta.byeWeek = phase2[2].value; }
  if(phase2[3].status==='fulfilled' && phase2[3].value){ sources.fmv=true; meta.fantasy = Object.assign({}, meta.fantasy, { fmv: phase2[3].value }); }
  if(phase2[4].status==='fulfilled' && Array.isArray(phase2[4].value) && phase2[4].value.length){ sources.espnNews=true; meta.news = phase2[4].value; }

  const payload = { ok:true, pid:String(pid), season, week, meta, sources };
  mset(key, payload); rset(key, JSON.stringify(payload)).catch(()=>{});
  return payload;
}

// ---- Routes (single error boundary) ----
router.get('/player/meta', async (req, res) => {
  const pid = String(req.query.pid||'');
  if(!isDigits(pid)) return res.status(400).json({ ok:false, error:'pid required (digits)' });
  const { season, week, leagueId, teamId } = hydrateCtx(req);

  try{
    const out = await buildMeta({ pid, season, week, leagueId, teamId });

    // projected-only mode
    const mode = String(req.query.view||req.query.only||req.query.fields||'').toLowerCase();
    const projectedOnly = mode==='projected' || mode==='proj' || String(req.query.projected||'')==='1';
    if(projectedOnly){
      const projected = (out.meta && out.meta.fantasy && out.meta.fantasy.proj != null) ? Number(out.meta.fantasy.proj) : null;
      const source = (out.meta && out.meta.fantasy && out.meta.fantasy.source) || (out.sources && out.sources.roster ? 'espn-roster' : null);
      return res.json({ ok:true, pid, season, week, leagueId, teamId, projected, source });
    }

    res.json(out);
  }catch(err){
    const code = (err && err.name==='AbortError') ? 504 : (err && err.status) ? err.status : 502;
    res.status(code).json({ ok:false, error: String(err && err.message || 'meta failure') });
  }
});

router.get('/player/meta/batch', async (req, res) => {
  const ids = String(req.query.pid||'').split(',').map(s=>s.trim()).filter(isDigits);
  if(!ids.length) return res.status(400).json({ ok:false, error:'pid comma-list required' });
  const ctx = hydrateCtx(req);

  const mode = String(req.query.view||req.query.only||req.query.fields||'').toLowerCase();
  const projectedOnly = mode==='projected' || mode==='proj' || String(req.query.projected||'')==='1';

  try{
    if(projectedOnly){
      const data = {};
      const settled = await Promise.allSettled(ids.map(pid => buildMeta({ pid, ...ctx })));
      settled.forEach((s, i)=>{
        const pid = ids[i];
        if(s.status==='fulfilled'){
          const out = s.value; const projected = (out.meta && out.meta.fantasy && out.meta.fantasy.proj != null) ? Number(out.meta.fantasy.proj) : null;
          const source = (out.meta && out.meta.fantasy && out.meta.fantasy.source) || (out.sources && out.sources.roster ? 'espn-roster' : null);
          data[pid] = { projected, source };
        } else {
          data[pid] = { projected: null, source: null };
        }
      });
      return res.json({ ok:true, season:ctx.season, week:ctx.week, leagueId:ctx.leagueId, teamId:ctx.teamId, data });
    }

    const out = {};
    const settled = await Promise.allSettled(ids.map(pid => buildMeta({ pid, ...ctx })));
    settled.forEach((s,i)=>{ const pid=ids[i]; if(s.status==='fulfilled') out[pid]=s.value; });
    res.json({ ok:true, data: out });
  }catch(err){
    const code = (err && err.name==='AbortError') ? 504 : (err && err.status) ? err.status : 502;
    res.status(code).json({ ok:false, error: String(err && err.message || 'meta batch failure') });
  }
});

module.exports = router;
