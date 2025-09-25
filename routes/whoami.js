const express = require('express');
const crypto = require('crypto');
const pool = require('../src/db/pool');
const { normalizeSwid, verifyEspnAuth } = require('../lib/espn');
const { setSessionCookie, clearEspnS2 } = require('../lib/cookies');

const router = express.Router();

async function getSession(sid){
  const r = await pool.query(
    `SELECT session_id, member_id FROM ff_session WHERE session_id=$1`,
    [sid]
  );
  return r.rows[0] || null;
}

router.get('/', async (req, res) => {
  try {
    let sid = req.cookies?.ff_sid || null;
    let sess = sid ? await getSession(sid) : null;

    // Try to authenticate from SWID + espn_s2 if no session yet
    if (!sess) {
      const swidCookie = req.cookies?.SWID || '';   // might include { } or be encoded
      const s2Cookie   = req.cookies?.espn_s2 || '';
      const swid = normalizeSwid(decodeURIComponent(String(swidCookie || '')));

      if (swid && s2Cookie) {
        const ok = await verifyEspnAuth({ swid, s2: s2Cookie });
        if (!ok) return res.status(401).json({ ok:false, error:'not_authenticated' });

        // Find existing member with this primary SWID (quick_snap)
        let memberId = null;
        const q1 = await pool.query(
          `SELECT member_id FROM ff_quickhitter WHERE quick_snap=$1 LIMIT 1`,
          [`{${swid}}`] // note: you store with braces in DB (see your sample row)
        );
        if (q1.rowCount) {
          memberId = q1.rows[0].member_id;
        } else {
          // If you had an ff_member cookie already, attach this SWID as primary to that member.
          const fallback = req.cookies?.ff_member || null;
          if (fallback) {
            await pool.query(
              `INSERT INTO ff_quickhitter (member_id, handle, quick_snap, color_hex, created_at, updated_at)
               VALUES ($1, NULL, $2, '000000', now(), now())
               ON CONFLICT (member_id) DO UPDATE SET quick_snap=EXCLUDED.quick_snap, updated_at=now()`,
              [fallback, `{${swid}}`]
            );
            memberId = fallback;
          }
        }

        if (memberId) {
          // Issue your own session
          sid = crypto.randomUUID().replace(/-/g,'');
          await pool.query(
            `INSERT INTO ff_session (session_id, member_id, created_at, last_seen_at, ip_hash, user_agent)
             VALUES ($1,$2, now(), now(), $3, $4)`,
            [
              sid, memberId,
              crypto.createHash('sha256').update(String(req.ip||'')).digest('hex'),
              String(req.headers['user-agent']||'').slice(0,300)
            ]
          );
          setSessionCookie(res, sid);
          clearEspnS2(res); // remove secret from your domain
          sess = { session_id: sid, member_id: memberId };
        }
      }
    }

    if (!sess) return res.status(401).json({ ok:false, error:'not_authenticated' });

    // Load member core & primary SWID
    const [qh, ghosts] = await Promise.all([
      pool.query(
        `SELECT member_id, handle, quick_snap, color_hex, email, phone
           FROM ff_quickhitter
          WHERE member_id=$1
          LIMIT 1`,
        [sess.member_id]
      ),
      pool.query(
        `SELECT swid FROM ff_member_ghost_swid WHERE member_id=$1 ORDER BY created_at ASC`,
        [sess.member_id]
      )
    ]);

    const row = qh.rows[0] || { member_id: sess.member_id, quick_snap: null, handle: null, color_hex: '000000' };
    const primarySwid = row.quick_snap ? normalizeSwid(row.quick_snap) : null;
    const ghostList = ghosts.rows.map(r => r.swid);

    // If a different SWID sits in cookies, offer to add as ghost
    const cookieSwid = normalizeSwid(decodeURIComponent(String(req.cookies?.SWID || '')));
    const offerGhost = !!(cookieSwid && cookieSwid !== primarySwid && !ghostList.includes(cookieSwid));

    return res.json({
      ok: true,
      member: {
        member_id: row.member_id,
        handle: row.handle,
        email: row.email,
        phone: row.phone,
        color_hex: row.color_hex
      },
      primarySwid,
      ghosts: ghostList,
      offerGhost,
      ghostCandidateSwid: offerGhost ? cookieSwid : null
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
