# fetch_fp_points.py
# Usage: python fetch_fp_points.py 2025 PPR --start 1 --end 18
# Requires: requests (`pip install requests`)
# Env var: FANTASYPROS_API_KEY

import os
import sys
import json
import argparse
import requests
from datetime import datetime
from pathlib import Path

FP_BASE = "https://api.fantasypros.com/public/v2/json/nfl"

TEAM_NORM = {
    "JAC": "JAX", "WAS": "WSH", "OAK": "LV",
    "SD": "LAC", "STL": "LAR", "LA": "LAR"
}

def norm_team(team):
    if not team:
        return ""
    team = team.upper()
    return TEAM_NORM.get(team, team)

def fetch_points(season, scoring, start, end, api_key):
    url = f"{FP_BASE}/{season}/player-points"
    params = {
        "scoring": scoring,
        "start": str(start),
        "end": str(end),
    }
    headers = {"x-api-key": api_key, "accept": "application/json"}
    r = requests.get(url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    return r.json()

def normalize(fp_json, season, scoring):
    players = fp_json.get("players", [])
    weeks_set = set()

    out_players = []
    for p in players:
        weeks = {}
        w = p.get("points", [])
                    #for w in p.get("points", []):

        wk = 1 #int(w.get("week", 0))
        val = w #float(w.get("value", 0))
        weeks[wk] = val
        weeks_set.add(wk)

        out_players.append({
            "fpId": p.get("player_id"),
            "name": p.get("player_name", ""),
            "position": p.get("position_id", "").upper(),
            "team": norm_team(p.get("team_id", "")),
            "weeks": weeks
        })

    return {
        "ok": True,
        "meta": {
            "season": season,
            "scoring": scoring,
            "weeks": sorted(list(weeks_set)),
            "fetchedAt": datetime.utcnow().isoformat()
        },
        "players": out_players
    }

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("season", type=int, help="Season year, e.g. 2025")
    parser.add_argument("scoring", type=str, choices=["STD", "HALF", "PPR"], help="Scoring type")
    parser.add_argument("--start", type=int, default=1, help="Start week")
    parser.add_argument("--end", type=int, default=18, help="End week")
    parser.add_argument("--outdir", type=str, default="data/fp", help="Output directory")
    args = parser.parse_args()

    api_key = os.getenv("FANTASYPROS_API_KEY")
    if not api_key:
        print("Error: FANTASYPROS_API_KEY environment variable not set.")
        sys.exit(1)

    print(f"Fetching FantasyPros points for {args.season} {args.scoring} weeks {args.start}-{args.end}...")
    raw = fetch_points(args.season, args.scoring, args.start, args.end, api_key)
    data = normalize(raw, args.season, args.scoring)

    outdir = Path(args.outdir) / str(args.season)
    outdir.mkdir(parents=True, exist_ok=True)
    outpath = outdir / f"{args.scoring}.json"
    with open(outpath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    print(f"Saved {len(data['players'])} players to {outpath}")

if __name__ == "__main__":
    main()
