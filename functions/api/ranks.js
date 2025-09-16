// functions/api/ranks.js
// Returns positional ranks from local FantasyPros CSVs.
// File pattern per position (QB,RB,WR,TE,K,DST):
//   /fp/FantasyPros_<SEASON>_Week_<WEEK>_<POS>_Rankings.csv
//
// Example: /fp/FantasyPros_2025_Week_1_QB_Rankings.csv
//
// Query:
//   /api/ranks?season=2025&week=1
//
// Response:
//   { ok:true, source:"csv", season:2025, week:1, count: N, ranks: { "QB:Josh Allen": 1, ... } }

const FP_RANK_CSV_BASE = "/fp";
const RANK_POSITIONS = ["QB","RB","WR","TE","K","DST"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

const toNum = (v, d=0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clampWeek = (w) => { const n = Number(w); return Number.isInteger(n) && n >= 1 && n <= 18 ? n : 1; };

// --- tiny CSV parser (quoted fields + commas)
function splitCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; } else { inQ = !inQ; }
    } else if (c === ',' && !inQ) {
      out.push(cur); cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Read a single CSV and produce { "POS:Full Name": rank }.
 * - Rank column: "RK"
 * - Name column: prefer "PLAYER NAME", else "Player", else first column.
 */
async function fetchRankCsvMap(origin, season, week, pos) {
  const file = `${FP_RANK_CSV_BASE}/FantasyPros_${season}_Week_${week}_${pos}_Rankings.csv`;
  const url  = `${origin}${file}`;
  try {
    const res = await fetch(url, { headers: { accept: "text/csv,text/plain,*/*" }, redirect: "follow" });
    if (!res.ok) return { _missing: file };
    const text = await res.text();
    if (!text) return { _missing: file };

    const lines = text.split(/\r?\n/).filter(l => l.trim().length);
    if (!lines.length) return { _missing: file };

    const header = splitCsvLine(lines[0]).map(h => String(h).trim());
    const findIdx = (name) => header.findIndex(h => h.toLowerCase() === name.toLowerCase());

    const rkIdx = findIdx("RK");
    const playerIdx = (() => {
      const i1 = findIdx("PLAYER NAME");
      if (i1 >= 0) return i1;
      const i2 = findIdx("Player");
      if (i2 >= 0) return i2;
      return 0;
    })();

    const out = {};
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsvLine(lines[i]).map(c => String(c).trim());
      if (!cells.length) continue;

      const name = cells[playerIdx] || "";
      if (!name) continue;

      let rank = null;
      if (rkIdx >= 0) {
        const r = Number(cells[rkIdx].replace(/[^\d.]/g, ""));
        if (Number.isFinite(r) && r > 0) rank = r;
      }
      if (rank === null) {
        const r = Number((cells[0] || "").replace(/[^\d.]/g, ""));
        if (Number.isFinite(r) && r > 0) rank = r;
      }
      if (rank === null) continue;

      out[`${pos}:${name}`] = rank;
    }
    return out;
  } catch {
    return { _missing: file };
  }
}

async function fetchRanksFromCsv(origin, season, week) {
  const perPos = await Promise.all(RANK_POSITIONS.map(p => fetchRankCsvMap(origin, season, week, p)));
  const ranks = {};
  const missing = [];
  for (const m of perPos) {
    if (m._missing) { missing.push(m._missing); continue; }
    Object.assign(ranks, m);
  }
  return { ranks, missing };
}

export const onRequestGet = async ({ request }) => {
  try {
    const u = new URL(request.url);
    const season = toNum(u.searchParams.get("season"), new Date().getFullYear());
    const week   = clampWeek(u.searchParams.get("week") || 1);

    const { ranks, missing } = await fetchRanksFromCsv(u.origin, season, week);

    return json({
      ok: true,
      source: "csv",
      season,
      week,
      count: Object.keys(ranks).length,
      missing: missing.length ? missing : undefined,
      ranks
    });
  } catch (err) {
    return json({ ok:false, error:String(err) }, 500);
  }
};
