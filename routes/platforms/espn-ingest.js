// --- helpers you can place near the top of the file ---
async function findMemberIdBySwid(pool, swid) {
  const { rows } = await pool.query(
    `SELECT member_id
       FROM ff_quickhitter
      WHERE LOWER(quick_snap) = LOWER($1)
      LIMIT 1`,
    [swid]
  );
  return rows[0]?.member_id || null;
}

async function getBestS2ForSwid(pool, swid, providedS2) {
  // prefer DB
  const { rows } = await pool.query(
    `SELECT espn_s2
       FROM ff_espn_cred
      WHERE LOWER(swid) = LOWER($1)
      ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
      LIMIT 1`,
    [swid]
  );
  return rows[0]?.espn_s2 || providedS2 || null;
}

async function upsertEspnCred(pool, swid, s2) {
  if (!swid || !s2) return;
  await pool.query(
    `INSERT INTO ff_espn_cred (swid, espn_s2, first_seen, last_seen)
     VALUES ($1,$2, now(), now())
     ON CONFLICT (swid) DO UPDATE
       SET espn_s2 = EXCLUDED.espn_s2,
           last_seen = now()`,
    [swid, s2]
  );
}

// ------------- PATCHED INGEST HANDLER -------------
router.post('/ingest', async (req, res) => {
  try {
    const minSeason = Number(req.body?.minSeason) || new Date().getFullYear();

    // Read creds from body, headers, or cookies
    const swidRaw = (req.body?.swid || req.get('x-espn-swid') || req.cookies?.SWID || req.cookies?.ff_espn_swid || '').trim();
    let s2Raw     = (req.body?.s2   || req.get('x-espn-s2')   || req.cookies?.espn_s2 || req.cookies?.ff_espn_s2 || '').trim();

    if (!swidRaw) return res.status(400).json({ ok:false, error:'missing_espn_creds' });

    // 1) Resolve member_id from ff_quickhitter.quick_snap (hard requirement)
    const member_id = await findMemberIdBySwid(pool, swidRaw);
    if (!member_id) {
      return res.status(400).json({ ok:false, error:'unknown_member_for_swid', swid: swidRaw });
    }

    // 2) Resolve best S2 for this SWID (DB > header/cookie/body)
    s2Raw = await getBestS2ForSwid(pool, swidRaw, s2Raw);
    if (!s2Raw) {
      return res.status(400).json({ ok:false, error:'missing_espn_s2_for_swid', swid: swidRaw });
    }

    // 3) Persist/refresh cred snapshot for next time
    await upsertEspnCred(pool, swidRaw, s2Raw);

    // 4) Call ESPN Fan API using cookies header
    const fanUrl = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swidRaw)}`;
    const resp = await fetch(fanUrl, {
      headers: {
        accept: 'application/json',
        cookie: `SWID=${swidRaw}; espn_s2=${encodeURIComponent(s2Raw)}`
      }
    });
    if (!resp.ok) {
      const body = await resp.text().catch(()=> '');
      return res.status(resp.status).json({ ok:false, error:'espn_fetch_failed', status: resp.status, body: body.slice(0,400) });
    }
    const chui = await resp.json();

    // 5) Create catalog + per-sport tables, upsert rows (reuses your helpers)
    await ensureCatalogTables();
    const grouped = extractRowsFromChuiAll({
      chui, minSeason, member_id, swid: swidRaw, s2: s2Raw
    });

    const results = {};
    for (const code of Object.keys(grouped)) {
      const tableName = await ensureSportTable(code);
      await upsertSportRows(tableName, grouped[code]);
      await refreshSportCatalog({ charCode: code, season: minSeason, tableName });
      results[code] = grouped[code].length;
    }

    return res.json({ ok:true, minSeason, member_id, wrote: results, sports: Object.keys(results).sort() });
  } catch (e) {
    console.error('[espn-ingest]', e);
    return res.status(500).json({ ok:false, error:'server_error', message:e.message });
  }
});
