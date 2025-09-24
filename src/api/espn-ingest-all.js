// src/api/espn-ingest-all.js
const pool = require('../db/pool'); // <- your shared Pool (no circular import)

/**
 * Fetch fan profile from ESPN fan API.
 * If espn_s2 is provided, send it as a cookie alongside SWID.
 */
async function fetchEspnFanProfile(swid, espn_s2) {
  const url = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`;

  const headers = { 'user-agent': 'ff-ingest/1.0' };
  const cookies = [];
  if (swid) cookies.push(`SWID=${swid}`);
  if (espn_s2) cookies.push(`espn_s2=${encodeURIComponent(espn_s2)}`);
  if (cookies.length) headers.cookie = cookies.join('; ');

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw Object.assign(new Error(`ESPN ${res.status}`), { status: res.status, body: t.slice(0,200) });
  }
  return res.json();
}

/** Upsert one fan row */
async function upsertFanRow({ swid, espn_s2, json }) {
  // pull a couple convenient fields if present (shape varies)
  const display = json?.displayName || json?.display_name || json?.profile?.displayName || null;
  const avatar  = json?.links?.avatar?.href || json?.avatar?.href || json?.profile?.avatar?.href || null;

  await pool.query(
    `
    INSERT INTO ff_espn_fan (swid, espn_s2, display_name, avatar_url, raw, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (swid) DO UPDATE SET
      espn_s2      = COALESCE(EXCLUDED.espn_s2, ff_espn_fan.espn_s2),
      display_name = COALESCE(EXCLUDED.display_name, ff_espn_fan.display_name),
      avatar_url   = COALESCE(EXCLUDED.avatar_url, ff_espn_fan.avatar_url),
      raw          = EXCLUDED.raw,
      updated_at   = NOW()
    `,
    [swid, espn_s2 || null, display, avatar, json]
  );
}

/**
 * Ingest all SWIDs from ff_quickhitter (left join to ff_espn_cred for s2).
 * Returns summary { total, ok, failed, items:[...] }
 */
async function ingestAllFans() {
  const { rows } = await pool.query(`
    SELECT
      q.quick_snap AS swid,
      c.espn_s2    AS s2
    FROM ff_quickhitter q
    LEFT JOIN ff_espn_cred c
      ON LOWER(c.swid) = LOWER(q.quick_snap)
    WHERE q.quick_snap IS NOT NULL AND q.quick_snap <> ''
  `);

  const out = { total: rows.length, ok: 0, failed: 0, items: [] };

  // light pacing to be nice to the API
  for (const r of rows) {
    const swid = r.swid;
    const s2   = r.s2 || null;
    try {
      const json = await fetchEspnFanProfile(swid, s2);
      await upsertFanRow({ swid, espn_s2: s2, json });
      out.ok++;
      out.items.push({ swid, ok: true });
      await new Promise(res => setTimeout(res, 200)); // 200ms between calls
    } catch (e) {
      out.failed++;
      out.items.push({ swid, ok:false, error: e.message, status: e.status });
    }
  }

  return out;
}

/** Ingest one specific SWID */
async function ingestOneFan(swid) {
  // get s2 if we have it
  const { rows } = await pool.query(`SELECT espn_s2 FROM ff_espn_cred WHERE LOWER(swid)=LOWER($1) LIMIT 1`, [swid]);
  const s2 = rows[0]?.espn_s2 || null;
  const json = await fetchEspnFanProfile(swid, s2);
  await upsertFanRow({ swid, espn_s2: s2, json });
  return { ok:true, swid };
}

module.exports = { ingestAllFans, ingestOneFan };
