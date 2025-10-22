/**
 * Player Meta API — CommonJS (require) + Express Router
 * ----------------------------------------------------
 * Drop-in router that aggregates rich player metadata for an ESPN pid.
 *
 * Mount:
 *   const meta = require('./routes/playerMeta');
 *   app.use('/api', meta); // exposes /api/player/meta and /api/player/meta/batch
 *
 * Requires Node 18+ (global fetch + AbortController). For older Node, install undici and set global.fetch.
 * Optional Redis cache: set REDIS_URL env.
 */

const express = require('express');
const router = express.Router();

// --- Optional Redis (guarded) ---
let redis = null;
try {
  const Redis = require('ioredis');
  if (process.env.REDIS_URL) redis = new Redis(process.env.REDIS_URL, { lazyConnect: true });
} catch (e) { /* ioredis not installed — memory cache only */ }

// --- Config ---
const FF_BASE = process.env.FF_BASE || 'https://fortifiedfantasy.com';
const MEM_TTL_MS = 12 * 60 * 1000; // 12m
const REDIS_TTL_SEC = 15 * 60;     // 15m

// --- Memory cache ---
const mem = new Map(); // key -> { exp:number, val:any }
function mget(key){ const v = mem.get(key); if(!v) return null; if(Date.now()>v.exp){ mem.delete(key); return null; } return v.val; }
function mset(key, val, ttlMs = MEM_TTL_MS){ mem.set(key, { exp: Date.now()+ttlMs, val }); }
async function rget(key){ if(!redis) return null; try{ if(!redis.status || redis.status==='end') await redis.connect(); return await redis.get(key); }catch{return null;} }
async function rset(key,val,ttl=REDIS_TTL_SEC){ if(!redis) return; try{ if(!redis.status || redis.status==='end') await redis.connect(); await redis.set(key, val, 'EX', ttl); }catch{} }

// --- Utils ---
function headshotUrl(pid){ return `https://a.espncdn.com/i/headshots/nfl/players/full/${pid}.png`; }
function isDigits(s){ return typeof s==='string' && /^[0-9]+$/.test(s); }

async function getJSON(url, timeoutMs = 1600){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'ff-meta/1.0 (+fortifiedfantasy.com)' } });
    if(!r.ok) throw new Error(String(r.status));
    return await r.json();
  } finally { clearTimeout(t); }
}

function mergeMeta(base, add){
  if(!add) return base;
  const out = { ...base };
  for(const k of Object.keys(add)){
    const v = add[k]; if(v==null) continue;
    if(Array.isArray(v)){ out[k] = (Array.isArray(out[k]) && out[k].length) ? out[k] : v; }
    else if(typeof v==='object'){ out[k] = mergeMeta(out[k]||{}, v); }
    else if(out[k]==null){ out[k] = v; }
  }
  return out;
}

// --- Param hydration (query -> headers -> referer QS) ---
function parseNum(v){ const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function pick(){ for(let i=0;i<arguments.length;i++){ const v=arguments[i]; if(v!=null && v!=='') return v; } return undefined; }
function hydrateCtx(req){
  const q = req.query || {}; const h = req.headers || {};
  let season = parseNum(pick(q.season, h['x-ff-season']));
  let week = parseNum(pick(q.week, h['x-ff-week']));
  let leagueId = parseNum(pick(q.leagueId, h['x-ff-league']));
  let teamId = parseNum(pick(q.teamId, h['x-ff-team']));
  const ref = req.get && req.get('referer');
  if((!leagueId || !teamId) && ref){
    try{ const u = new URL(ref); leagueId = leagueId || parseNum(u.searchParams.get('leagueId')); teamId = teamId || parseNum(u.searchParams.get('teamId')); season = season || parseNum(u.searchParams.get('season')); week = week || parseNum(u.searchParams.get('week')); }catch{}
  }
  return { season, week, leagueId, teamId };
}

// --- Sources ---
async function fromRoster(ctx, pid){
  const { season, week, leagueId, teamId } = ctx;
  if(!(season && leagueId && teamId)){
    if(process.env.DEBUG){ console.warn('[playerMeta] fromRoster skipped — missing season/leagueId/teamId', { season, leagueId, teamId }); }
    return null;
  }
  const scopeWeek = week ? `week&week=${week}` : 'season';
  const urls = [
    `${FF_BASE}/api/platforms/espn/roster?season=${season}&leagueId=${leagueId}&teamId=${teamId}&scope=${scopeWeek}`,
    `${FF_BASE}/api/platforms/espn/roster?season=${season}&leagueId=${leagueId}&teamId=${teamId}&scope=season`,
  ];
  for(const u of urls){
    try{
      const j = await getJSON(u, 1800);
      const list = Array.isArray(j && j.players) ? j.players : [];
      const p = list.find(x => String(x.playerId)===String(pid));
      if(p){
        return {
          id: String(p.playerId),
          name: p.name,
          position: p.position,
          team: { abbr: p.teamAbbr },
          headshot: p.headshot || headshotUrl(String(p.playerId)),
          fantasy: { proj: Number(p.proj)||null, source: 'espn-roster', lineupSlotId: Number(p.lineupSlotId)||null },
          teamContext: { isStarter: !!p.isStarter, lineupSlotId: Number(p.lineupSlotId)||null },
        };
      }
    }catch(e){ /* next */ }
  }
  return null;
}

async function fromEspnAthlete(pid){
  const url = `https://site.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${pid}`;
  try{
    const j = await getJSON(url, 1800);
    const a = (j && j.athlete) ? j.athlete : j;
    if(!a || (!a.id && !a.fullName)) return null;
    const team = a.team || a.collegeTeam || a.proTeam || {};
    const injury = (a.injuries && a.injuries[0]) || a.defaultInjury || {};
    const expYears = (a.experience && a.experience.years) || a.experience;
    return {
      id: String(a.id || pid),
      name: a.fullName || a.displayName,
      firstName: a.firstName, lastName: a.lastName,
      jersey: a.jersey,
      position: (a.position && (a.position.abbreviation || a.position.displayName)) || a.position,
      team: { id: a.teamId ? String(a.teamId) : (team.id?String(team.id):undefined), abbr: team.abbreviation, name: team.displayName || team.name },
      headshot: (a.headshot && a.headshot.href) || headshotUrl(pid),
      physical: { heightIn: a.height?Number(a.height):undefined, weightLb: a.weight?Number(a.weight):undefined, age: a.age, birthDate: a.dateOfBirth },
      experience: { years: expYears?Number(expYears):undefined, display: a.experience && a.experience.displayValue },
      college: (a.college && a.college.name) || a.college,
      draft: a.draft ? { year: a.draft.year, round: a.draft.round, pick: a.draft.selection, team: a.draft.team && a.draft.team.abbreviation } : undefined,
      status: { active: a.active, rosterStatus: (a.status && a.status.type) || a.status },
      injury: injury && (injury.status || injury.details || injury.description) ? { status: injury.status, description: injury.details || injury.description, date: injury.date } : undefined,
    };
  }catch(e){ return null; }
}

async function fromEspnNews(pid){
  const urls = [
    `https://site.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${pid}/news`,
    `https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=5&aggregated=true&players=${pid}`,
  ];
  for(const u of urls){
    try{
      const j = await getJSON(u, 1500);
      const items = (j && (j.news || j.articles || j.items)) || [];
      if(items.length){
        return items.slice(0,5).map(n=>({
          headline: n.headline || n.title,
          description: n.description || n.blurb,
          published: n.published || n.lastModified || n.date,
          link: (n.links && n.links.web && n.links.web.href) || n.link || n.url,
          source: n.source || 'ESPN',
        }));
      }
    }catch(e){ /* next */ }
  }
  return [];
}

async function buildMeta(ctx){
  const { pid, season, week, leagueId, teamId } = ctx;
  const key = `pm:v1:${pid}:${season||'x'}:${week||'x'}:${leagueId||'x'}:${teamId||'x'}`;
  const cached = mget(key) || (await (async()=>{ const s = await rget(key); return s ? JSON.parse(s) : null; })());
  if(cached) return cached;

  const sources = {};
  let meta = { id: pid, headshot: headshotUrl(pid) };

  const roster = await fromRoster({ season, week, leagueId, teamId }, pid);
  if(roster){ sources.roster = true; meta = mergeMeta(roster, meta); }

  const athlete = await fromEspnAthlete(pid);
  if(athlete){ sources.espnAthlete = true; meta = mergeMeta(meta, athlete); }

  const news = await fromEspnNews(pid);
  if(news && news.length){ sources.espnNews = true; meta.news = news; }

  const payload = { ok:true, pid, season, week, meta, sources };
  mset(key, payload); rset(key, JSON.stringify(payload)).catch(()=>{});
  return payload;
}

// --- Routes ---
router.get('/player/meta', async (req, res) => {
  try{
    const pid = String(req.query.pid||'');
    if(!isDigits(pid)) return res.status(400).json({ ok:false, error:'pid required (digits)' });
    const { season, week, leagueId, teamId } = hydrateCtx(req);

    const out = await buildMeta({ pid, season, week, leagueId, teamId });
    res.json(out);
  }catch(err){ console.error('meta error', err); res.status(500).json({ ok:false, error:'internal' }); }
});
    const season   = req.query.season ? Number(req.query.season) : undefined;
    const week     = req.query.week   ? Number(req.query.week)   : undefined;
    const leagueId = req.query.leagueId ? Number(req.query.leagueId) : undefined;
    const teamId   = req.query.teamId   ? Number(req.query.teamId)   : undefined;

    const out = await buildMeta({ pid, season, week, leagueId, teamId });
    res.json(out);
  }catch(err){ console.error('meta error', err); res.status(500).json({ ok:false, error:'internal' }); }
});

router.get('/player/meta/batch', async (req, res) => {
  try{
    const ids = String(req.query.pid||'').split(',').map(s=>s.trim()).filter(isDigits);
    if(!ids.length) return res.status(400).json({ ok:false, error:'pid comma-list required' });
    const ctx = hydrateCtx(req);
    const out = {};
    await Promise.all(ids.map(async pid => { out[pid] = await buildMeta({ pid, ...ctx }); }));
    res.json({ ok:true, data: out });
  }catch(err){ console.error('meta batch error', err); res.status(500).json({ ok:false, error:'internal' }); }
});
    const season   = req.query.season ? Number(req.query.season) : undefined;
    const week     = req.query.week   ? Number(req.query.week)   : undefined;
    const leagueId = req.query.leagueId ? Number(req.query.leagueId) : undefined;
    const teamId   = req.query.teamId   ? Number(req.query.teamId)   : undefined;

    const out = {};
    await Promise.all(ids.map(async pid => { out[pid] = await buildMeta({ pid, season, week, leagueId, teamId }); }));
    res.json({ ok:true, data: out });
  }catch(err){ console.error('meta batch error', err); res.status(500).json({ ok:false, error:'internal' }); }
});

module.exports = router;
