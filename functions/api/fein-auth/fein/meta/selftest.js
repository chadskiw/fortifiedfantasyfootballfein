CHECK THIS OUT
// TRUE_LOCATION: functions/api/fein-auth/fein/meta/selftest.js
// IN_USE: FALSE
// GET /api/fein-auth/fein/meta/selftest
app.get('/api/fein-auth/fein/meta/selftest', async (req, res) => {
  const { Pool } = require('pg');
  try {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
    });
    const r = await pool.query('SELECT 1 as ok');
    // show what the server sees for creds (from headers or cookies)
    const swid = req.get('x-espn-swid') || (req.headers.cookie||'').includes('SWID') ? 'cookie_present' : '';
    const s2   = req.get('x-espn-s2')   || (req.headers.cookie||'').includes('espn_s2') ? 'cookie_present' : '';
    res.json({ ok: true, db: r.rows[0], credsSeen: { swid: !!swid, s2: !!s2 } });
  } catch (e) {
    res.status(500).json({ ok:false, error:'db_error', message: e.message, code: e.code });
  }
});
