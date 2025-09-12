import express from 'express';
import { espnSvc } from '../services/espn.js';

// This router simply proxies to your existing ESPN service
// while keeping a consistent surface for the new unified UI.
export function espnRouter() {
  const r = express.Router();

  r.get('/league/teams', async (req, res) => {
    const { leagueId, season } = req.query;
    if (!leagueId || !season) return res.status(400).json({ ok:false, error:'leagueId and season required' });
    try {
      const data = await espnSvc.leagueTeams({ leagueId, season });
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok:false, error:String(e.message||e) });
    }
  });

  r.get('/roster', async (req, res) => {
    const { leagueId, teamId, season } = req.query;
    if (!leagueId || !teamId || !season) return res.status(400).json({ ok:false, error:'leagueId, teamId, season required' });
    try {
      const data = await espnSvc.roster({ leagueId, teamId, season });
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok:false, error:String(e.message||e) });
    }
  });

  r.get('/draft-board', async (req, res) => {
    const { leagueId, season } = req.query;
    if (!leagueId || !season) return res.status(400).json({ ok:false, error:'leagueId and season required' });
    try {
      const data = await espnSvc.draftBoard({ leagueId, season });
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok:false, error:String(e.message||e) });
    }
  });

  return r;
}
