// functions/api/dvp.js
// Build a DvP rank map from FantasyPros CSV (no external libs).
// Output: { "ARI|QB": 11, "ARI|RB": 23, "ATL|QB": 23, ... }

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

// Minimal CSV parser (handles quotes, commas in quotes, and BOM)
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM

  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } // escaped quote
        else { inQ = false; }
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch === '\r') { /* ignore */ }
      else cell += ch;
    }
  }
  if (cell.length || inQ) row.push(cell);
  if (row.length) rows.push(row);
  return rows;
}

// Team name → abbreviation
const NAME_TO_ABBR = {
  "Arizona Cardinals":"ARI","Atlanta Falcons":"ATL","Baltimore Ravens":"BAL","Buffalo Bills":"BUF",
  "Carolina Panthers":"CAR","Chicago Bears":"CHI","Cincinnati Bengals":"CIN","Cleveland Browns":"CLE",
  "Dallas Cowboys":"DAL","Denver Broncos":"DEN","Detroit Lions":"DET","Green Bay Packers":"GB",
  "Houston Texans":"HOU","Indianapolis Colts":"IND","Jacksonville Jaguars":"JAX","Kansas City Chiefs":"KC",
  "Las Vegas Raiders":"LV","Los Angeles Chargers":"LAC","Los Angeles Rams":"LAR","Miami Dolphins":"MIA",
  "Minnesota Vikings":"MIN","New England Patriots":"NE","New Orleans Saints":"NO","New York Giants":"NYG",
  "New York Jets":"NYJ","Philadelphia Eagles":"PHI","Pittsburgh Steelers":"PIT","San Francisco 49ers":"SF",
  "Seattle Seahawks":"SEA","Tampa Bay Buccaneers":"TB","Tennessee Titans":"TEN","Washington Commanders":"WSH"
};
const TEAM_NORM = { JAC:"JAX", WAS:"WSH", OAK:"LV", SD:"LAC", STL:"LAR", LA:"LAR" };
const normTeamAbbr = a => TEAM_NORM[String(a||"").toUpperCase()] || String(a||"").toUpperCase();

// --- helpers ---
const TEAM_ABBR = {
  "Arizona Cardinals":"ARI","Atlanta Falcons":"ATL","Baltimore Ravens":"BAL","Buffalo Bills":"BUF",
  "Carolina Panthers":"CAR","Chicago Bears":"CHI","Cincinnati Bengals":"CIN","Cleveland Browns":"CLE",
  "Dallas Cowboys":"DAL","Denver Broncos":"DEN","Detroit Lions":"DET","Green Bay Packers":"GB",
  "Houston Texans":"HOU","Indianapolis Colts":"IND","Jacksonville Jaguars":"JAX","Kansas City Chiefs":"KC",
  "Las Vegas Raiders":"LV","Los Angeles Chargers":"LAC","Los Angeles Rams":"LAR","Miami Dolphins":"MIA",
  "Minnesota Vikings":"MIN","New England Patriots":"NE","New Orleans Saints":"NO","New York Giants":"NYG",
  "New York Jets":"NYJ","Philadelphia Eagles":"PHI","Pittsburgh Steelers":"PIT","San Francisco 49ers":"SF",
  "Seattle Seahawks":"SEA","Tampa Bay Buccaneers":"TB","Tennessee Titans":"TEN","Washington Commanders":"WSH"
};
const normTeamName = (s) => TEAM_ABBR[String(s||'').trim()] || String(s||'').trim().toUpperCase();
const normPos = (p) => (String(p||'').toUpperCase().replace('D/ST','DST').replace('DEF','DST'));

// robust CSV cell splitter
function splitCsvLine(line) {
  const out = []; let cur = ""; let inQ = false;
  for (let i=0;i<line.length;i++){
    const c=line[i];
    if (c === '"') { if (inQ && line[i+1] === '"'){ cur+='"'; i++; } else { inQ=!inQ; } }
    else if (c === ',' && !inQ) { out.push(cur); cur=""; }
    else { cur+=c; }
  }
  out.push(cur);
  return out;
}

// main: parse Team vs Position CSV into { "WSH|WR": 12, "BUF|DST": 31, ... }
function parseDvpCsvToMap(csvText){
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return {};

  const header = splitCsvLine(lines[0]).map(h => h.trim());
  const idxTeam = header.findIndex(h => h.toLowerCase() === 'team');
  if (idxTeam < 0) return {};

  // Locate columns. Pattern is: Team, Rank, QB, Rank, RB, ... , K, Rank, DST
  // For QB/RB/WR/TE/K use the Rank column; DST has only a value column.
  const posCols = {};
  const POS = ['QB','RB','WR','TE','K'];
  for (let i=0;i<header.length;i++){
    const h = header[i].toUpperCase();
    if (POS.includes(h) && header[i+1] && header[i+1].toLowerCase() === 'rank') {
      posCols[h] = { valueIdx: i, rankIdx: i+1 };
      i++; // skip the paired 'Rank'
    }
  }
  // DST single column
  const dstIdx = header.findIndex(h => h.toUpperCase() === 'DST');
  if (dstIdx >= 0) posCols.DST = { valueIdx: dstIdx, rankIdx: null };

  // Collect rows
  const rows = [];
  for (let r=1; r<lines.length; r++){
    const cells = splitCsvLine(lines[r]).map(c => c.trim());
    if (!cells.length) continue;
    const teamAbbr = normTeamName(cells[idxTeam]);
    if (!teamAbbr) continue;

    const record = { team: teamAbbr, vals: {}, ranks: {} };
    for (const p of Object.keys(posCols)){
      const { valueIdx, rankIdx } = posCols[p];
      const val  = Number(cells[valueIdx]?.replace(/[^\d.]/g,''));
      const rank = rankIdx!=null ? Number(cells[rankIdx]?.replace(/[^\d.]/g,'')) : null;
      if (Number.isFinite(val))  record.vals[p]  = val;
      if (Number.isFinite(rank)) record.ranks[p] = rank;
    }
    rows.push(record);
  }

  // Compute DST ranks if missing: rank by value DESC (higher points allowed = easier = rank 1)
  if (rows.length && (!rows[0].ranks.DST)) {
    const sorted = [...rows].sort((a,b) => (b.vals.DST ?? -Infinity) - (a.vals.DST ?? -Infinity));
    sorted.forEach((rec, i) => { rec.ranks.DST = i + 1; }); // 1..32
  }

// Positions we care about (order matters to read pairs)
}


const POS_CANON   = ["QB","RB","WR","TE","K","DST"];
const POS_ALIASES = {
  QB:["QB"], RB:["RB"], WR:["WR"], TE:["TE"],
  K:["K","PK"], DST:["DST","D/ST"]
};
async function highestWeek() {
  let max = 1;
  try {
    const res = await fetch("/fpa/"); // directory listing (static hosting)
    const text = await res.text();
    const regex = /_Wk_(\d+)(?=\.csv)/gi;

    let m;
    while ((m = regex.exec(text))) {
      const w = parseInt(m[1], 10);
      if (w > max) max = w;
    }
  } catch (e) {
    console.warn("highestWeek() scan failed:", e?.message || e);
  }
  return max;
}
export const onRequestGet = async ({ request }) => {
  async function loadCsvText(request) {
  const base = new URL(request.url);
  const tries = [
    new URL(`/fpa/FantasyPros_Fantasy_Football_Points_Allowed_Wk_${highestWeek}.csv`, base),
    new URL("/public/FantasyPros_Fantasy_Football_Points_Allowed.csv", base),
  ];
  for (const url of tries) {
    const r = await fetch(url.toString());
    if (r.ok) return r.text();
  }
  throw new Error("CSV not found at /FantasyPros_….csv or /public/FantasyPros_….csv");
}

  try {
    const text  = await loadCsvText(request);          // your existing helper
    const rows  = parseCSV(text);                      // your existing helper
    if (!rows?.length) return json({ ok:false, error:"Empty CSV" }, 400);

    // --- headers
    const header = rows[0].map(h => String(h || "").trim().toUpperCase());
    const posIdx = {}; // e.g. { QB:{rankIdx:1, valIdx:2}, ..., DST:{rankIdx:11, valIdx:12} }

    for (let i = 0; i < header.length - 1; i++) {
      const cur = header[i];
      const nxt = header[i+1];
      if (cur === "RANK") {
        const pos = POS_CANON.find(P => POS_ALIASES[P].includes(nxt));
        if (pos) { posIdx[pos] = { rankIdx: i, valIdx: i+1 }; i++; }
      }
    }

    // sanity: we expect all six
    for (const p of POS_CANON) {
      if (!posIdx[p]) return json({ ok:false, error:`Missing Rank→${p} header pairing` }, 400);
    }

    // --- rows → map
    const map = {}; // `${TEAM}|${POS}` -> integer rank

    const toInt = (v) => {
      const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };

    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r]; if (!cells?.length) continue;

      const teamName = String(cells[0] || "").trim();
      let abbr = NAME_TO_ABBR[teamName] || "";     // your map like {"Arizona Cardinals":"ARI", ...}
      if (!abbr) continue;
      abbr = normTeamAbbr(abbr);                   // JAC->JAX, WAS->WSH, etc.

      for (const P of POS_CANON) {
        const { rankIdx } = posIdx[P];
        const rk = (rankIdx < cells.length) ? toInt(cells[rankIdx]) : null;
        if (rk != null) {
          map[`${abbr}|${P}`] = rk;
          // handy aliases (no harm if duplicated):
          for (const a of POS_ALIASES[P]) map[`${abbr}|${a}`] = rk;
        }
      }
    }

    return json({ ok:true, map });
  } catch (err) {
    return json({ ok:false, error:"Unhandled exception", detail:String(err?.stack || err) }, 500);
  }
};
