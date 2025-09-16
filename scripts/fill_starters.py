
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fill_starters.py — DEBUG build (verbose) for ESPN depth charts
==============================================================
- Prints step-by-step logs so you can see EXACTLY where it fails.
- Tries multiple ESPN JSON endpoints per team (id-based + slug-based).
- Optionally dumps RAW JSON per team so you can inspect shapes.
- Writes final to ../public/dc/depth_charts_2025.json relative to this script.

Run (Windows):
  "C:\Program Files\Python311\python.exe" scripts\fill_starters.py --dump-raw

Flags:
  --dump-raw     Save raw JSON for each team to ../public/dc/raw/<ABBR>.json

If everything is still empty, you'll at least have per-team raw files to inspect.
"""

import sys, time, json, os, re, argparse
from typing import Dict, List, Tuple
from pathlib import Path
import requests

SEASON = 2025

HEADERS = {
    "User-Agent": "FortifiedFantasy/1.0 (+https://fortifiedfantasy.com)",
    "Accept": "application/json,text/plain;q=0.9,*/*;q=0.8",
    "Pragma": "no-cache",
    "Cache-Control": "no-cache",
}

# Known endpoints to try (in this order) ------------------------------
API_TEAMS = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=40"  # fetch ids/abbrs
API_DEPTH_ID = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{id}/depthcharts"   # by id (plural)
API_DEPTH_SLUG = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{slug}/depthchart" # by slug (singular, older)

NFL_TEAMS = [
    "ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB",
    "HOU","IND","JAX","KC","LV","LAC","LAR","MIA","MIN","NE","NO","NYG","NYJ",
    "PHI","PIT","SF","SEA","TB","TEN","WSH"
]

TEAM_ID: Dict[str,int] = {}
TEAM_SLUG: Dict[str,str] = {}     # e.g., HOU -> 'hou'
TEAM_NAME: Dict[str,str] = {}     # e.g., HOU -> 'Texans'

def log(msg: str):
    print(msg, flush=True)

def http_json(url: str) -> dict:
    log(f"  GET {url}")
    r = requests.get(url, headers=HEADERS, timeout=20)
    log(f"  -> status {r.status_code}, content-type {r.headers.get('content-type','?')}")
    r.raise_for_status()
    try:
        j = r.json()
        log(f"  -> parsed JSON ok ({len(r.content)} bytes)")
        return j
    except Exception as e:
        log(f"  !! JSON parse error: {e}")
        raise

def build_team_maps():
    log("[1/3] Fetching team maps (abbr -> id/slug/name)...")
    data = http_json(API_TEAMS)

    items = []
    if isinstance(data.get("sports"), list):
        for sport in data["sports"]:
            for league in sport.get("leagues", []):
                items.extend(league.get("teams", []))
    if not items and isinstance(data.get("teams"), list):
        items = data["teams"]

    count = 0
    for it in items:
        team = it.get("team") or it
        abbr = (team.get("abbreviation") or "").upper()
        tid  = team.get("id")
        slug = team.get("slug") or (team.get("location", "") + "-" + team.get("nickname","")).lower().replace(" ","-")
        name = team.get("nickname") or team.get("name") or team.get("displayName") or abbr
        try:
            tid = int(tid)
        except Exception:
            tid = None
        if abbr and tid:
            TEAM_ID[abbr] = tid
            TEAM_SLUG[abbr] = (slug or abbr.lower())
            TEAM_NAME[abbr] = name
            count += 1

    log(f"  -> mapped {count} teams. Example: HOU -> id {TEAM_ID.get('HOU')}, slug {TEAM_SLUG.get('HOU')}, name {TEAM_NAME.get('HOU')}")
    missing = [t for t in NFL_TEAMS if t not in TEAM_ID]
    if missing:
        log(f"  !! Missing ids for: {', '.join(missing)}")

def clean_name(t: str) -> str:
    t = (t or "").strip()
    t = re.sub(r"\s+", " ", t)
    t = t.replace("’", "'").replace("–","-")
    return t

def uniq(seq: List[str]) -> List[str]:
    seen = set()
    out = []
    for s in seq:
        k = s.lower()
        if k and k not in seen:
            seen.add(k)
            out.append(s)
    return out

def extract_from_position_block(block: dict) -> tuple[str, list[str]]:
    """Return (POS_ABBR, [names...]) from a single position block if it matches."""
    pos = (block.get("position") or {}).get("abbreviation") or block.get("positionAbbreviation") or ""
    if not pos:
        return "", []
    pos = pos.upper().strip()

    names: list[str] = []
    rows = block.get("athletes") or block.get("items") or []
    for row in rows:
        athlete = row.get("athlete")
        name = None
        if isinstance(athlete, dict):
            name = athlete.get("displayName") or athlete.get("fullName") or athlete.get("name")
        if not name:
            name = row.get("displayName") or row.get("name")
        if name:
            names.append(clean_name(name))
    return pos, uniq(names)


def parse_depth_json(dc: dict) -> dict[str, list[str]]:
    """
    Robustly find position groups anywhere in the JSON:
    - If 'depthCharts' exists, drill into each item.
    - Otherwise, recursively search for arrays of objects that have BOTH:
        * a 'position' with 'abbreviation'
        * an 'athletes' (or 'items') list
    """
    pos_map: dict[str, list[str]] = {"QB": [], "RB": [], "WR": [], "TE": [], "K": []}

    # 1) If ESPN nests under 'depthCharts', flatten those first
    candidates = []
    if isinstance(dc.get("depthCharts"), list) and dc["depthCharts"]:
        for chart in dc["depthCharts"]:
            if isinstance(chart, dict):
                if isinstance(chart.get("positions"), list):
                    candidates.extend(chart["positions"])
                if isinstance(chart.get("items"), list):
                    candidates.extend(chart["items"])

    # 2) If nothing yet, recursively search entire payload for position blocks
    def walk(obj):
        if isinstance(obj, dict):
            # If this dict already looks like a position group, collect it
            if isinstance(obj.get("position"), dict) and (
                isinstance(obj.get("athletes"), list) or isinstance(obj.get("items"), list)
            ):
                candidates.append(obj)
            # Recurse into all values
            for v in obj.values():
                walk(v)
        elif isinstance(obj, list):
            for v in obj:
                walk(v)

    if not candidates:
        walk(dc)

    # 3) Parse all candidate blocks we found
    for block in candidates:
        pos, names = extract_from_position_block(block)
        if pos in pos_map and names:
            pos_map[pos].extend(names)

    # 4) Deduplicate
    for k in pos_map:
        pos_map[k] = uniq(pos_map[k])

    log(f"    containers found: {len(candidates)}; parsed -> " +
        ", ".join(f"{k}:{len(v)}" for k, v in pos_map.items()))
    return pos_map



def fetch_depth_for_team(abbr: str, dump_dir: Path|None) -> Dict[str, List[str]]:
    tid = TEAM_ID.get(abbr)
    slug = TEAM_SLUG.get(abbr)
    if not tid or not slug:
        raise RuntimeError(f"Unknown team id/slug for {abbr}")

    # Try id-based depthcharts first
    endpoints = [
        ("id:depthcharts", API_DEPTH_ID.format(id=tid)),
        ("slug:depthchart", API_DEPTH_SLUG.format(slug=slug)),
    ]

    last_exc = None
    for label, url in endpoints:
        try:
            log(f"  [{abbr}] Trying {label}")
            dc = http_json(url)
            if dump_dir:
                (dump_dir / f"{abbr}_{label.replace(':','_')}.json").write_text(json.dumps(dc, indent=2), encoding="utf-8")
            posmap = parse_depth_json(dc)
            if any(posmap.values()):
                log(f"  [{abbr}] success via {label}")
                return posmap
            else:
                log(f"  [{abbr}] {label} returned no positions; trying next...")
        except Exception as e:
            last_exc = e
            log(f"  [{abbr}] {label} error: {e}")

    # If all fail, raise last exception
    if last_exc:
        raise last_exc
    raise RuntimeError(f"{abbr}: no valid depth source")

def pick_top(n: int, arr: List[str]) -> List[str]:
    return [x for x in arr if x][:n]

def build_team_output(abbr: str, dump_dir: Path|None) -> Dict[str, List[str]]:
    posmap = fetch_depth_for_team(abbr, dump_dir)

    wrs = pick_top(3, posmap.get("WR", []))
    dst_name = f"{TEAM_NAME.get(abbr, abbr)} D/ST"

    return {
        "QB": pick_top(2, posmap.get("QB", [])),
        "RB": pick_top(2, posmap.get("RB", [])),
        "WR1": [wrs[0]] if len(wrs) > 0 else [],
        "WR2": [wrs[1]] if len(wrs) > 1 else [],
        "WR3": [wrs[2]] if len(wrs) > 2 else [],
        "TE": pick_top(2, posmap.get("TE", [])),
        "K": pick_top(1, posmap.get("K", [])),
        "DST": [dst_name]
    }

def main(argv=None):
    parser = argparse.ArgumentParser(description="Verbose ESPN depth chart builder")
    parser.add_argument("--dump-raw", action="store_true", help="Dump raw per-team JSON to ../public/dc/raw")
    args = parser.parse_args(argv)

    # Paths
    script_dir = Path(__file__).resolve().parent
    repo_root = script_dir.parent
    out_dir = repo_root / "public" / "dc"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"depth_charts_{SEASON}.json"
    dump_dir = (out_dir / "raw") if args.dump_raw else None
    if dump_dir:
        dump_dir.mkdir(parents=True, exist_ok=True)

    log(f"=== FortifiedFantasy depth chart builder (season {SEASON}) ===")
    build_team_maps()

    teams_out = {}
    for abbr in NFL_TEAMS:
        log(f"[2/3] Building {abbr}...")
        try:
            teams_out[abbr] = build_team_output(abbr, dump_dir)
        except Exception as e:
            log(f"  !! {abbr} failed: {e}")
            name = TEAM_NAME.get(abbr, abbr)
            teams_out[abbr] = {"QB": [], "RB": [], "WR1": [], "WR2": [], "WR3": [], "TE": [], "K": [], "DST": [f"{name} D/ST"]}

    payload = {
        "season": SEASON,
        "source": "ESPN depth chart pages",
        "lastUpdated": int(time.time()),
        "teams": teams_out
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    log(f"[3/3] Wrote {out_path}")

if __name__ == "__main__":
    main()