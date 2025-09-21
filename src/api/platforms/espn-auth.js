// src/api/platforms/espn-auth.js
const express = require('express');

module.exports = function createEspnAuthRouter(pool){
  const router = express.Router();

  // Helpers
  const readCookie = (req, name) => {
    const raw = (req.headers.cookie || '')
      .split(';')
      .map(s => s.trim())
      .find(s => s.toLowerCase().startsWith(name.toLowerCase() + '='));
    return raw ? decodeURIComponent(raw.split('=').slice(1).join('=')) : '';
  };
  const normSwid = v => {
    const core = String(v || '').trim().replace(/[{}]/g,'').toUpperCase();
    return core ? `{${core}}` : '';
  };

  async function ensureCredTable(){
    // swid+s2 pair keyed; verified means “we’ve already confirmed this pair belongs to member_id”
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ff_espn_cred (
        swid            text NOT NULL,
        espn_s2         text NOT NULL,
        member_id       text,                 -- who owns it (nullable until claimed)
        verified        boolean NOT NULL DEFAULT false,
        created_at      timestamptz NOT NULL DEFAULT now(),
        last_seen_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (swid, espn_s2)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS ff_espn_cred_member_idx ON ff_espn_cred(member_id)`);
  }

  // Quick “do we have cookies?” check you referenced earlier
  router.get('/authcheck', (req, res) => {
    const swid = normSwid(readCookie(req, 'ff_espn_swid') || readCookie(req, 'SWID'));
    const s2   = (readCookie(req, 'ff_espn_s2') || readCookie(req, 'ESPN_S2') || '').trim();
    const ok = !!(swid && s2);
    return res.json({ ok, swid: !!swid, s2: !!s2 });
  });

  // Core resolver the YES button will call
  router.post('/resolve', express.json(), async (req, res) => {
    try{
      await ensureCredTable();

      // from body or cookies (body wins)
      const swid = normSwid(req.body?.swid || readCookie(req, 'ff_espn_swid') || readCookie(req, 'SWID'));
      const s2   = String(req.body?.espn_s2 || readCookie(req, 'ff_espn_s2') || readCookie(req, 'ESPN_S2') || '').trim();

      if (!swid || !s2) {
        return res.status(400).json({ ok:false, error:'missing_creds' });
      }

      // Upsert last_seen + stub row if new
      await pool.query(`
        INSERT INTO ff_espn_cred (swid, espn_s2, verified, last_seen_at)
        VALUES ($1,$2,false,now())
        ON CONFLICT (swid, espn_s2) DO UPDATE SET last_seen_at = now()
      `,[swid, s2]);

      // Look up status
      const { rows:[cred] } = await pool.query(
        `SELECT swid, espn_s2, member_id, verified FROM ff_espn_cred WHERE swid=$1 AND espn_s2=$2`,
        [swid, s2]
      );

      // Soft “you’ve interacted” cookie (1 year) – helps your UX gating
      res.cookie('ff_interacted', '1', { httpOnly:false, sameSite:'Lax', maxAge:31536000000, path:'/' });

      // Decide next step for the client
      if (cred?.verified && cred?.member_id){
        // already verified => send to your auth puzzle (or straight to app if you prefer)
        return res.json({
          ok:true,
          next:'puzzle',
          // tweak this to your actual route
          url:'/fein/auth/puzzle?src=espn'
        });
      }

      // Not yet verified → guide to signup (prefill + mark ESPN connected)
      // You can also stash a short-lived prefill cookie the signup page reads.
      const prefill = {
        connected:'espn',
        swid,
        s2
      };
      res.cookie('ff_prefill', Buffer.from(JSON.stringify(prefill)).toString('base64'), {
        httpOnly:false, sameSite:'Lax', maxAge: 10*60*1000, path:'/'
      });

      return res.json({
        ok:true,
        next:'signup',
        url:'/signup?connected=espn&prefill=1'
      });
    }catch(e){
      console.error('[espn/resolve]', e);
      return res.status(500).json({ ok:false, error:'server_error' });
    }
  });

  return router;
};
