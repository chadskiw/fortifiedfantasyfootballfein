import express from 'express';
import { cget, slp } from '../services/sleeper.js';

function slpTeamName(u) {
  return (u?.metadata?.team_name) || u?.metadata?.nickname || u?.display_name || u?.username || 'Team';
}
function toCardFromDict(p, pid) {
  const name = p?.full_name || [p?.first_name, p?.last_name].filter(Boolean).join(' ') || `#${pid}`;
  const pos  = p?.position || p?.fantasy_positions?.[0] || '';
  const nfl  = (p?.team || '').toUpperCase();
  return {
    pid: String(pid),
    name, pos, nfl,
    provider: 'sleeper',
    photo: `https://sleepercdn.com/content/nfl/players/thumb/${pid}.jpg`
  };
}

export function sleeperRouter() {
  const r = express.Router();

  // Raw helpful endpoints
  r.get('/user/:username', async (req, res) => {
    try { res.json(await cget(slp.user(req.params.username))); }
    catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
  });
  r.get('/leagues', async (req, res) => {
    const { userId, season } = req.query;
    if (!userId || !season) return res.status(400).json({ ok:false, error:'userId and season required' });
    try { res.json(await cget(slp.leagues(userId, season))); }
    catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
  });

  // Normalized: league teams
  r.get('/league/teams', async (req, res) => {
    const { leagueId } = req.query;
    if (!leagueId) return res.status(400).json({ ok:false, error:'leagueId required' });
    try {
      const [lg, users, rosters] = await Promise.all([
        cget(slp.league(leagueId)),
        cget(slp.users(leagueId)),
        cget(slp.rosters(leagueId))
      ]);
      const byUser = new Map(users.map(u => [String(u.user_id), u]));
      const teams = rosters.map(r => ({
        provider: 'sleeper',
        season: Number(lg.season || new Date().getFullYear()),
        leagueId: String(leagueId),
        leagueName: lg.name || 'Sleeper League',
        teamId: String(r.owner_id),
        userId: String(r.owner_id),
        teamName: slpTeamName(byUser.get(String(r.owner_id)))
      }));
      res.json({ ok:true, teams });
    } catch (e) {
      res.status(500).json({ ok:false, error:String(e.message||e) });
    }
  });

  // Normalized: roster
  r.get('/roster', async (req, res) => {
    const { leagueId, userId } = req.query;
    if (!leagueId || !userId) return res.status(400).json({ ok:false, error:'leagueId and userId required' });
    try {
      const [users, rosters, dict] = await Promise.all([
        cget(slp.users(leagueId)),
        cget(slp.rosters(leagueId)),
        cget(slp.players())
      ]);
      const byUser = new Map(users.map(u => [String(u.user_id), u]));
      const rr = rosters.find(x => String(x.owner_id) === String(userId));
      if (!rr) return res.status(404).json({ ok:false, error:'Roster not found' });

      const starters = (rr.starters || []).map(pid => toCardFromDict(dict[pid], pid));
      const all      = (rr.players  || []).map(pid => toCardFromDict(dict[pid], pid));
      const bench    = all.filter(p => !starters.find(s => s.pid === p.pid));
      const teamName = slpTeamName(byUser.get(String(rr.owner_id)));

      res.json({ ok:true, teamName, starters, bench, all });
    } catch (e) {
      res.status(500).json({ ok:false, error:String(e.message||e) });
    }
  });

  // Normalized: draft board
  r.get('/draft-board', async (req, res) => {
    const { leagueId } = req.query;
    if (!leagueId) return res.status(400).json({ ok:false, error:'leagueId required' });
    try {
      const [lg, users, rosters, drafts] = await Promise.all([
        cget(slp.league(leagueId)),
        cget(slp.users(leagueId)),
        cget(slp.rosters(leagueId)),
        cget(slp.drafts(leagueId))
      ]);
      const draftId = drafts?.[0]?.draft_id;
      const picksRaw = draftId ? await cget(slp.draftPicks(draftId)) : [];
      const rosterOrder = rosters.slice().sort((a,b)=>a.roster_id - b.roster_id);
      const teamsBySlot = rosterOrder.map(r => {
        const u = users.find(u => u.user_id === r.owner_id);
        return { slot: r.roster_id, id: String(r.owner_id), name: slpTeamName(u) };
      });
      const rounds = Number(lg.settings?.draft_rounds || 16);
      const picks = picksRaw.map(p => ({
        round: Number(p.round),
        col: Number(p.pick_no), // 1..N left->right
        teamId: String(rosters.find(r => r.roster_id === p.roster_id)?.owner_id || ''),
        playerId: String(p.player_id)
      }));
      res.json({ ok:true, leagueName: lg.name || 'Sleeper League', teamsBySlot, rounds, picks });
    } catch (e) {
      res.status(500).json({ ok:false, error:String(e.message||e) });
    }
  });

  return r;
}
