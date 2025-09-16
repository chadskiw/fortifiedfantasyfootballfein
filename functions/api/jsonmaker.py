#!/usr/bin/env python3
"""
Scrape 2025 NFL depth charts (starters & primary backups) from ESPN team pages.

Output:
  ./data/depth_charts_2025.json

Key features:
- Handles BOTH ESPN layouts:
  (a) classic single-table (pos in col 1 + players in same row)
  (b) two-table "fixed-left" layout: positions table (left) + players table (right)
- Extracts ONLY real player names from <a> links (ignores "2nd", "3rd", "-" labels).
- Offense: QB, RB (incl. HB/TB/FB) top 2; WR first 3 as WR1..WR3; TE top 2.
- Special Teams: K (first).
- D/ST synthesized from team nickname.
"""

import json, os, re, time
from typing import Dict, List, Any
import requests
from bs4 import BeautifulSoup

# ---- Team codes/slugs and abbrs ----
ESPN_CODES = {
    "ari": ("Arizona", "Cardinals"),
    "atl": ("Atlanta", "Falcons"),
    "bal": ("Baltimore", "Ravens"),
    "buf": ("Buffalo", "Bills"),
    "car": ("Carolina", "Panthers"),
    "chi": ("Chicago", "Bears"),
    "cin": ("Cincinnati", "Bengals"),
    "cle": ("Cleveland", "Browns"),
    "dal": ("Dallas", "Cowboys"),
    "den": ("Denver", "Broncos"),
    "det": ("Detroit", "Lions"),
    "gb":  ("Green Bay", "Packers"),
    "hou": ("Houston", "Texans"),
    "ind": ("Indianapolis", "Colts"),
    "jax": ("Jacksonville", "Jaguars"),
    "kc":  ("Kansas City", "Chiefs"),
    "lv":  ("Las Vegas", "Raiders"),
    "lac": ("Los Angeles", "Chargers"),
    "lar": ("Los Angeles", "Rams"),
    "mia": ("Miami", "Dolphins"),
    "min": ("Minnesota", "Vikings"),
    "ne":  ("New England", "Patriots"),
    "no":  ("New Orleans", "Saints"),
    "nyg": ("New York", "Giants"),
    "nyj": ("New York", "Jets"),
    "phi": ("Philadelphia", "Eagles"),
    "pit": ("Pittsburgh", "Steelers"),
    "sf":  ("San Francisco", "49ers"),
    "sea": ("Seattle", "Seahawks"),
    "tb":  ("Tampa Bay", "Buccaneers"),
    "ten": ("Tennessee", "Titans"),
    "wsh": ("Washington", "Commanders"),
}

TEAM_ABBR = {
    "ari":"ARI","atl":"ATL","bal":"BAL","buf":"BUF","car":"CAR","chi":"CHI","cin":"CIN",
    "cle":"CLE","dal":"DAL","den":"DEN","det":"DET","gb":"GB","hou":"HOU","ind":"IND",
    "jax":"JAX","kc":"KC","lv":"LV","lac":"LAC","lar":"LAR","mia":"MIA","min":"MIN",
    "ne":"NE","no":"NO","nyg":"NYG","nyj":"NYJ","phi":"PHI","pit":"PIT","sf":"SF",
    "sea":"SEA","tb":"TB","ten":"TEN","wsh":"WSH"
}

HEADERS = { "User-Agent": "FortifiedFantasy/1.0 (+https://fortifiedfantasy.com)" }

# ---- Helpers ----
DEPTH_LABELS = {"1ST","2ND","3RD","4TH","5TH","-","RES","IR","PUP","SUS","PS"}
OFFENSE_POS_TOKENS = {"QB","RB","HB","TB","FB","WR","TE","LT","LG","C","RG","RT"}
SPECIAL_POS_TOKENS = {"K","PK"}

def clean(txt: str) -> str:
    t = re.sub(r"\s+", " ", txt or "").strip()
    t = re.sub(r"^\d+\.\s*", "", t)  # strip "12. Joe Burrow"
    return t

def is_depth_label(txt: str) -> bool:
    return txt and txt.strip().upper() in DEPTH_LABELS

def fetch_html(url: str) -> str:
    r = requests.get(url, headers=HEADERS, timeout=20)
    r.raise_for_status()
    return r.text

def extract_names_from_cells_anchors(cells) -> List[str]:
    """Return player names from <a> tags only."""
    out: List[str] = []
    for c in cells:
        for a in c.find_all("a", href=True):
            nm = clean(a.get_text())
            if nm and not is_depth_label(nm):
                out.append(nm)
    return out

# ---- Classic single-table parsing (pos in col1, players in same row) ----
def parse_classic_tables(soup: BeautifulSoup, slots: Dict[str, List[str]]):
    def first_cell_pos_text(tr) -> str:
        cells = tr.find_all(["td","th"])
        if not cells: return ""
        return clean(cells[0].get_text()).upper()

    def classify_table(tbl) -> str:
        kinds = set()
        for tr in tbl.find_all("tr"):
            pos = first_cell_pos_text(tr)
            if not pos or is_depth_label(pos): 
                continue
            pos_norm = "WR" if pos.startswith("WR") else pos
            if pos_norm in OFFENSE_POS_TOKENS: kinds.add("offense")
            if pos_norm in SPECIAL_POS_TOKENS: kinds.add("special")
        if "special" in kinds and "offense" not in kinds:
            return "special"
        if "offense" in kinds:
            return "offense"
        return "other"

    # Extract from an offense table
    def parse_offense_table(tbl):
        wr_bucket: List[str] = []
        for tr in tbl.find_all("tr"):
            cells = tr.find_all(["td","th"])
            if len(cells) < 2: 
                continue
            pos = clean(cells[0].get_text()).upper()
            if not pos or is_depth_label(pos):
                continue
            pos_norm = "WR" if pos.startswith("WR") else pos
            names = extract_names_from_cells_anchors(cells[1:])
            if not names:
                continue
            if pos_norm == "QB":
                for nm in names[:2]:
                    if nm not in slots["QB"]: slots["QB"].append(nm)
            elif pos_norm in {"RB","HB","TB","FB"}:
                for nm in names[:2]:
                    if nm not in slots["RB"]: slots["RB"].append(nm)
            elif pos_norm == "WR":
                for nm in names:
                    if nm not in wr_bucket: wr_bucket.append(nm)
            elif pos_norm == "TE":
                for nm in names[:2]:
                    if nm not in slots["TE"]: slots["TE"].append(nm)
        for i, nm in enumerate(wr_bucket[:3], start=1):
            key = f"WR{i}"
            if nm not in slots[key]: slots[key].append(nm)

    # Extract from a special teams table
    def parse_special_table(tbl):
        for tr in tbl.find_all("tr"):
            cells = tr.find_all(["td","th"])
            if len(cells) < 2:
                continue
            pos = clean(cells[0].get_text()).upper()
            if not pos or is_depth_label(pos):
                continue
            pos_norm = "WR" if pos.startswith("WR") else pos
            if pos_norm in {"K","PK"}:
                names = extract_names_from_cells_anchors(cells[1:])
                if names:
                    nm = names[0]
                    if nm not in slots["K"]: slots["K"].append(nm)

    for tbl in soup.find_all("table"):
        kind = classify_table(tbl)
        if kind == "offense":
            parse_offense_table(tbl)
        elif kind == "special":
            parse_special_table(tbl)
        else:
            continue  # ignore defense/other

# ---- Fixed-left two-table parsing (your pasted HTML) ----
def parse_fixed_left_blocks(soup: BeautifulSoup, slots: Dict[str, List[str]]):
    """
    Each ResponsiveTable--fixed-left block contains:
      - Left fixed table: first column (positions)
      - Right scroller table: columns for Starter / 2nd / 3rd / 4th
    We iterate rows by index, pairing left row position with right row players.
    """
    blocks = soup.select(".ResponsiveTable.ResponsiveTable--fixed-left")
    wr_bucket: List[str] = []

    for block in blocks:
        left_tbl = block.select_one(".Table--fixed-left")
        right_tbl = block.select_one(".Table__Scroller table.Table")
        if not left_tbl or not right_tbl:
            continue

        left_rows  = left_tbl.select("tbody tr")
        right_rows = right_tbl.select("tbody tr")
        row_count = min(len(left_rows), len(right_rows))
        if row_count == 0:
            continue

        for i in range(row_count):
            ltr = left_rows[i]
            rtr = right_rows[i]

            # Position from left row, normalize
            pos = clean(ltr.get_text()).upper()
            if not pos or is_depth_label(pos):
                continue
            pos_norm = "WR" if pos.startswith("WR") else pos

            # Player names from right row cells (Starter/2nd/3rd/4th)
            rcells = rtr.find_all("td")
            names = extract_names_from_cells_anchors(rcells)
            if not names:
                continue

            if pos_norm == "QB":
                for nm in names[:2]:
                    if nm not in slots["QB"]: slots["QB"].append(nm)

            elif pos_norm in {"RB","HB","TB","FB"}:
                for nm in names[:2]:
                    if nm not in slots["RB"]: slots["RB"].append(nm)

            elif pos_norm == "WR":
                for nm in names:
                    if nm not in wr_bucket: wr_bucket.append(nm)

            elif pos_norm == "TE":
                for nm in names[:2]:
                    if nm not in slots["TE"]: slots["TE"].append(nm)

            elif pos_norm in {"K","PK"}:
                nm = names[0]
                if nm not in slots["K"]: slots["K"].append(nm)

    # Map first three WRs found across the block(s)
    for i, nm in enumerate(wr_bucket[:3], start=1):
        key = f"WR{i}"
        if nm not in slots[key]: slots[key].append(nm)

# ---- Team page parser (combines both strategies) ----
def parse_team_depth_chart(html: str, team_code: str) -> Dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    slots = { "QB":[], "RB":[], "WR1":[], "WR2":[], "WR3":[], "TE":[], "K":[], "DST":[] }

    # First try fixed-left blocks (if present)
    parse_fixed_left_blocks(soup, slots)
    # Also parse classic tables (harmless if duplicates; we dedupe)
    parse_classic_tables(soup, slots)

    # D/ST synthesized from nickname
    city, nick = ESPN_CODES[team_code]
    dst_label = f"{nick} D/ST"
    if dst_label not in slots["DST"]:
        slots["DST"].append(dst_label)

    return {
        "teamCode": team_code,
        "teamAbbr": TEAM_ABBR.get(team_code, team_code.upper()),
        "teamName": f"{city} {nick}",
        "slots": slots
    }

# ---- Driver ----
def main():
    os.makedirs("data", exist_ok=True)
    results: Dict[str, Any] = {
        "season": 2025,
        "source": "ESPN depth chart pages",
        "lastUpdated": int(time.time()),
        "teams": {}
    }

    for code in ESPN_CODES:
        url = f"https://www.espn.com/nfl/team/depth/_/name/{code}"
        print(f"[fetch] {code.upper()} -> {url}")
        try:
            html = fetch_html(url)
            team = parse_team_depth_chart(html, code)
            results["teams"][team["teamAbbr"]] = team["slots"]
            time.sleep(0.5)  # polite
        except Exception as e:
            print(f"[warn] {code.upper()} failed: {e}")

    out_path = os.path.join("data", "depth_charts_2025.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"[done] wrote {out_path}")

if __name__ == "__main__":
    main()
