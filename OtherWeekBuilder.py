#!/usr/bin/env python3
"""
Standalone Alt Week Page Builder (with Week 1–14 autogeneration)

- Preserves output format and function names from your snippet.
- Reads ALT_TMPL from a provided template file (so HTML output remains unchanged).
- Writes: week{W}/index.html
- Can build a single week or a range (e.g., 1..14) without changing outputs.

Defaults so it "just runs":
  - Week range: Weeks 1–14 (regular season)
  - Depths: ./data/depth_charts_2025.json
  - Template: ./data/alt_template.html
"""

from __future__ import annotations
import argparse
import json
import sys
from datetime import datetime
from html import escape
from pathlib import Path
from typing import Any, Dict, List, Tuple

# ----------------------------
# ALT_TMPL is loaded from file
# ----------------------------
ALT_TMPL: str = ""  # populated at runtime from --template path


def _safe_join(names: List[str]) -> str:
    return ", ".join([n for n in names if n])


def _pos_table(rows: List[List[Any] | Tuple[Any, ...]], headers: List[str]) -> str:
    th = "".join(f"<th>{h}</th>" for h in headers)
    trs = []
    for r in rows:
        tds = "".join(f"<td>{escape(str(x))}</td>" for x in r)
        trs.append(f"<tr>{tds}</tr>")
    return f"<table><thead><tr>{th}</tr></thead><tbody>{''.join(trs)}</tbody></table>"


def build_alt_sections(depths: List[Dict[str, Any]]):
    # Make it resilient to missing keys
    norm = []
    for t in depths:
        team = (t or {}).get("team", "")
        slots = (t or {}).get("slots", {}) or {}
        norm.append({"team": team, "slots": slots})

    qbs  = [(t['team'], t['slots'].get('QB1', '')) for t in norm if t['slots'].get('QB1')]
    rbs  = [(t['team'], t['slots'].get('RB1', ''), t['slots'].get('RB2', '')) for t in norm if t['slots'].get('RB1')]
    wrs  = [(t['team'], t['slots'].get('WR1', ''), t['slots'].get('WR2', ''), t['slots'].get('WR3', '')) for t in norm if t['slots'].get('WR1')]
    tes  = [(t['team'], t['slots'].get('TE1', '')) for t in norm if t['slots'].get('TE1')]
    ks   = [(t['team'], t['slots'].get('K', '')) for t in norm if t['slots'].get('K')]
    dsts = [(t['team'], t['slots'].get('DST', '')) for t in norm if t['slots'].get('DST')]

    qb_html  = _pos_table(qbs,  ["Team", "QB1"])
    rb_html  = _pos_table(rbs,  ["Team", "RB1", "RB2"])
    wr_html  = _pos_table(wrs,  ["Team", "WR1", "WR2", "WR3"])
    te_html  = _pos_table(tes,  ["Team", "TE1"])
    k_html   = _pos_table(ks,   ["Team", "K"])
    dst_html = _pos_table(dsts, ["Team", "D/ST"])

    notes = []
    for t in norm:
        s = t["slots"]
        blip = (
            f"{t['team']}: "
            f"QB {s.get('QB1','')} · "
            f"RB {s.get('RB1','')}/{s.get('RB2','')} · "
            f"WR {s.get('WR1','')}, {s.get('WR2','')}, {s.get('WR3','')} · "
            f"TE {s.get('TE1','')} · "
            f"K {s.get('K','')} · "
            f"{s.get('DST','')}"
        )
        notes.append(f"<div>{escape(blip)}</div>")
    depth_notes = "\n".join(notes)

    return qb_html, rb_html, wr_html, te_html, k_html, dst_html, depth_notes


# ----------------------------
# CLI + path resolution
# ----------------------------
def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build Alt Week pages from depths + HTML template.")
    group = p.add_mutually_exclusive_group(required=False)
    group.add_argument("--week", type=int, help="Single week number (e.g., 1..18)")
    group.add_argument("--regular-season", action="store_true", help="Build Weeks 1–14 automatically.")

    p.add_argument("--start-week", type=int, default=None, help="Custom range start (inclusive). Use with --end-week.")
    p.add_argument("--end-week",   type=int, default=None, help="Custom range end (inclusive). Use with --start-week.")

    # Defaults to your repo layout (relative)
    p.add_argument("--depths",   type=Path, default=Path("data/depth_charts_2025.json"),
                   help="Path to depths JSON (default: data/depth_charts_2025.json)")
    p.add_argument("--template", type=Path, default=Path("data/alt_template.html"),
                   help="Path to HTML template (default: data/alt_template.html)")
    return p.parse_args()


def _first_existing(paths: List[Path]) -> Path | None:
    for p in paths:
        if p and p.exists():
            return p
    return None


def _resolve_file_or_die(user_path: Path, fallbacks: List[Path], what: str) -> Path:
    if user_path and user_path.exists():
        return user_path
    found = _first_existing(fallbacks)
    if found:
        return found
    msg = [f"[error] {what} file not found."]
    msg.append(f"  Tried: {user_path}")
    for f in fallbacks:
        msg.append(f"         {f}")
    sys.exit("\n".join(msg))

def write_alt_week_page(week: int, depths: List[Dict[str, Any]]):
    """
    Writes week{week}/index.html.
    Output is identical to your original snippet (same placeholders & structure).
    """
    qb_html, rb_html, wr_html, te_html, k_html, dst_html, depth_notes = build_alt_sections(depths)

    html = ALT_TMPL
    html = html.replace("{{W}}", str(week))
    html = html.replace("{{QB_HTML}}", qb_html)
    html = html.replace("{{RB_HTML}}", rb_html)
    html = html.replace("{{WR_HTML}}", wr_html)
    html = html.replace("{{TE_HTML}}", te_html)
    html = html.replace("{{K_HTML}}", k_html)
    html = html.replace("{{DST_HTML}}", dst_html)
    html = html.replace("{{DEPTH_NOTES}}", depth_notes)
    html = html.replace("{{YEAR}}", str(datetime.utcnow().year))

    week_dir = Path(f"rosters/week{week}")
    week_dir.mkdir(parents=True, exist_ok=True)
    (week_dir / "index.html").write_text(html, encoding="utf-8")



# ---------- NEW: schema-aware loader ----------
def _normalize_from_teams_map(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Accepts {"teams": { "BUF": {"QB": [...], "RB":[...], "WR1":[...], "WR2":[...], "WR3":[...], "TE":[...], "K":[...], "DST":[...]}, ...}}
    Produces: [{"team":"BUF", "slots":{"QB1": "...", "RB1": "...", "RB2":"...", "WR1":"...", "WR2":"...", "WR3":"...", "TE1":"...", "K":"...", "DST":"..." }}, ...]
    """
    teams = data.get("teams", {}) or {}
    out: List[Dict[str, Any]] = []

    def first(arr: Any) -> str:
        if isinstance(arr, list) and arr:
            return str(arr[0])
        return ""

    def nth(arr: Any, n: int) -> str:
        if isinstance(arr, list) and len(arr) > n:
            return str(arr[n])
        return ""

    for abbr, posmap in teams.items():
        posmap = posmap or {}
        qb = posmap.get("QB", [])
        rb = posmap.get("RB", [])
        slots = {
            "QB1": first(qb),
            "RB1": first(rb),
            "RB2": nth(rb, 1),
            # WRs are already split by "WR1/WR2/WR3" arrays
            "WR1": first(posmap.get("WR1", [])),
            "WR2": first(posmap.get("WR2", [])),
            "WR3": first(posmap.get("WR3", [])),
            "TE1": first(posmap.get("TE", [])),
            "K":   first(posmap.get("K", [])),
            "DST": first(posmap.get("DST", [])),
        }
        out.append({"team": abbr, "slots": slots})
    return out


def _load_depths(path: Path) -> List[Dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        sys.exit(f"[error] failed to read depths JSON: {path}\n{e}")

    # Format A: already a list of {team, slots}
    if isinstance(data, list):
        return data

    # Format B: object with 'depths' list
    if isinstance(data, dict) and "depths" in data and isinstance(data["depths"], list):
        return data["depths"]

    # Format C: your league object with a 'teams' map
    if isinstance(data, dict) and "teams" in data and isinstance(data["teams"], dict):
        return _normalize_from_teams_map(data)

    sys.exit(
        "[error] Unrecognized depths schema.\n"
        "Expected one of:\n"
        "  1) a list of {team, slots} objects\n"
        "  2) an object with key 'depths' (list)\n"
        "  3) an object with key 'teams' (map like your JSON sample)\n"
    )
# ---------- /loader ----------


def _resolve_weeks(args: argparse.Namespace) -> List[int]:
    # default to regular season if no week flags
    if args.week is None and args.start_week is None and args.end_week is None and not args.regular_season:
        return list(range(1, 15))

    if args.regular_season:
        return list(range(1, 15))

    if args.start_week is not None or args.end_week is not None:
        if args.start_week is None or args.end_week is None:
            sys.exit("Provide both --start-week and --end-week (or use --regular-season).")
        if args.start_week < 1 or args.end_week < args.start_week:
            sys.exit("Invalid week range.")
        return list(range(args.start_week, args.end_week + 1))

    if args.week is not None:
        if args.week < 1 or args.week > 18:
            sys.exit("Week must be in 1..18.")
        return [args.week]

    return list(range(1, 15))


def main():
    global ALT_TMPL
    args = _parse_args()

    # Resolve template with smart fallbacks (cwd-aware)
    template = _resolve_file_or_die(
        args.template,
        fallbacks=[
            Path("alt_template.html"),
            Path("data/alt_template.html"),
            Path("./alt_template.html"),
            Path("./data/alt_template.html"),
        ],
        what="template"
    )
    try:
        ALT_TMPL = template.read_text(encoding="utf-8")
    except Exception as e:
        sys.exit(f"[error] failed to read template HTML: {template}\n{e}")

    # Resolve depths file with fallbacks
    depths_path = _resolve_file_or_die(
        args.depths,
        fallbacks=[
            Path("data/depth_charts_2025.json"),
            Path("./data/depth_charts_2025.json"),
            Path("depth_charts_2025.json"),
        ],
        what="depths"
    )
    depths = _load_depths(depths_path)

    weeks = _resolve_weeks(args)
    for w in weeks:
        write_alt_week_page(w, depths)
        print(f"✓ Built week{w}/index.html")


if __name__ == "__main__":
    main()
