#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate SEO-optimized Start/Sit pages (Weeks 1–14) from depth_charts_2025.json.

INPUT (your file shape)
  {
    "lastUpdated": <epoch>,
    "teams": {
      "BUF": {
        "QB":  ["Josh Allen","..."],
        "RB":  ["James Cook","Ray Davis"],
        "WR1": ["Stefon Diggs"],
        "WR2": ["Khalil Shakir"],
        "WR3": ["Keon Coleman"],
        "TE":  ["Dalton Kincaid","..."],
        "K":   ["Tyler Bass"],
        "DST": ["Bills D/ST"]
      },
      "KC": { ... },
      ...
    }
  }

OUTPUT
  /start-sit/week1/index.html ... /start-sit/week14/index.html
  /start-sit/index.html
  /sitemap.xml
  /robots.txt

USAGE
  python scripts\\WeekNBuilder.py
"""

import json, re, textwrap
from pathlib import Path
from html import escape
from datetime import datetime

# ---------- CONFIG ----------
BASE_DIR = Path(r"C:\Users\cwhitese\Downloads\ff-cloudflare")
DATA_FILE = BASE_DIR / "data" / "depth_charts_2025.json"

OUT_ROOT  = BASE_DIR
OUT_WEEKS = BASE_DIR / "start-sit"
OUT_WEEKS.mkdir(parents=True, exist_ok=True)

HOMEPAGE_URL = "/"
SITE_ORIGIN  = "https://fortifiedfantasy.com"

GENERATE_ROBOTS = True
MAX_FAQ_ENTRIES_PER_PAGE = 40

SEASON = 2025
WEEKS = list(range(1, 15))

# Internal normalized slot keys (what we output)
POSITION_KEYS = ["QB1","RB1","RB2","WR1","WR2","WR3","TE1","K","DST"]
POSITION_HUMAN = {
    "QB1":"QB", "RB1":"RB", "RB2":"RB", "WR1":"WR", "WR2":"WR", "WR3":"WR",
    "TE1":"TE", "K":"K", "DST":"D/ST"
}

# Optional team name map for nicer labels (fill if you want long names in-page)
TEAM_LONG = {
    "ARI":"Arizona Cardinals","ATL":"Atlanta Falcons","BAL":"Baltimore Ravens","BUF":"Buffalo Bills",
    "CAR":"Carolina Panthers","CHI":"Chicago Bears","CIN":"Cincinnati Bengals","CLE":"Cleveland Browns",
    "DAL":"Dallas Cowboys","DEN":"Denver Broncos","DET":"Detroit Lions","GB":"Green Bay Packers",
    "HOU":"Houston Texans","IND":"Indianapolis Colts","JAX":"Jacksonville Jaguars","KC":"Kansas City Chiefs",
    "LAC":"Los Angeles Chargers","LAR":"Los Angeles Rams","LV":"Las Vegas Raiders","MIA":"Miami Dolphins",
    "MIN":"Minnesota Vikings","NE":"New England Patriots","NO":"New Orleans Saints","NYG":"New York Giants",
    "NYJ":"New York Jets","PHI":"Philadelphia Eagles","PIT":"Pittsburgh Steelers","SEA":"Seattle Seahawks",
    "SF":"San Francisco 49ers","TB":"Tampa Bay Buccaneers","TEN":"Tennessee Titans","WSH":"Washington Commanders",
}

# ---------- LOAD & NORMALIZE ----------
def _first(arr):
    return arr[0].strip() if isinstance(arr, list) and arr and isinstance(arr[0], str) else ""

def load_depths_from_your_file(path: Path):
    """Parse your team→array schema and normalize to our POSITION_KEYS."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    teams_blob = raw.get("teams", {})

    normalized = []
    for abbr, slots in teams_blob.items():
        abbr = str(abbr).strip().upper()
        # Source keys are arrays; we map them to our outputs
        qb1  = _first(slots.get("QB", []))
        rb1  = _first(slots.get("RB", []))
        rb2  = slots.get("RB", [])
        rb2  = rb2[1].strip() if isinstance(rb2, list) and len(rb2) > 1 and isinstance(rb2[1], str) else ""
        wr1  = _first(slots.get("WR1", []))
        wr2  = _first(slots.get("WR2", []))
        wr3  = _first(slots.get("WR3", []))
        te1  = _first(slots.get("TE", []))
        k    = _first(slots.get("K", []))
        dst  = _first(slots.get("DST", []))

        normalized.append({
            "team": abbr,
            "city": "",  # optional if you don’t have it in your JSON
            "name": TEAM_LONG.get(abbr, abbr),
            "slots": {
                "QB1": qb1,
                "RB1": rb1,
                "RB2": rb2,
                "WR1": wr1,
                "WR2": wr2,
                "WR3": wr3,
                "TE1": te1,
                "K":   k,
                "DST": dst,
            }
        })
    return normalized

def team_long_display(t):
    # e.g., "Buffalo Bills (BUF)"
    long_name = t["name"] if t["name"] else t["team"]
    return f"{long_name} ({t['team']})"

def weeks_nav_html(current_week: int):
    parts = []
    for w in WEEKS:
        if w == current_week:
            parts.append(f"<strong>{w}</strong>")
        else:
            parts.append(f'<a href="/start-sit/week{w}/">{w}</a>')
    return " · ".join(parts)

def canonical(url_path: str) -> str:
    return url_path if url_path.endswith("/") else (url_path + "/")

# ---------- CONTENT BUILDERS ----------
def build_questions_for_player(player: str, pos_human: str, week: int, team_disp: str):
    if not player:
        return []
    p = player
    w = week
    pos = pos_human
    return [
        f"Should I start {p} in Week {w} fantasy {pos}?",
        f"Start or sit {p} for Week {w}?",
        f"Is {p} a good start in Week {w}?",
        f"Week {w} {pos} start/sit: {p}",
        f"{p} Week {w} fantasy outlook and projections",
        f"Is {p} a must-start in Week {w}?",
        f"Who to start Week {w} at {pos}? Is {p} a top option?",
        f"Best {pos} to start Week {w}: is {p} in the top tier?",
        f"{p} matchup & start advice for Week {w}",
        f"{p} Week {w} lineup advice: start or bench?",
        f"{p} Week {w} start/sit vs alternatives",
        f"{team_disp}: Should I start {p} in Week {w}?",
    ]

def build_big_li_block(depths, week: int):
    lines = []
    for t in depths:
        team_disp = team_long_display(t)
        slots = t["slots"]
        for key in POSITION_KEYS:
            pos_h = POSITION_HUMAN[key]
            player = slots.get(key, "")
            lines += build_questions_for_player(player, pos_h, week, team_disp)
    # De-dupe
    seen = set(); uniq = []
    for q in lines:
        qn = q.strip()
        if qn and qn not in seen:
            seen.add(qn); uniq.append(qn)
    # Paragraph chunks
    chunks = []
    para = []
    for i, q in enumerate(uniq, 1):
        para.append(escape(q))
        if i % 18 == 0:
            chunks.append("<p>" + " ".join(para) + "</p>")
            para = []
    if para:
        chunks.append("<p>" + " ".join(para) + "</p>")
    return "\n".join(chunks)

def build_faq_json(depths, week: int):
    # Small, valid FAQ subset so Google actually honors it.
    entities = []
    for t in depths:
        qb = t["slots"].get("QB1") or ""
        if qb:
            entities.append({
                "@type": "Question",
                "name": f"Should I start {qb} in Week {week}?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": f"{qb} is in consideration for Week {week}. Use our free start/sit tool for projections, matchup DvP, and FMV context."
                }
            })
        if len(entities) >= MAX_FAQ_ENTRIES_PER_PAGE:
            break

    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": entities[:MAX_FAQ_ENTRIES_PER_PAGE]
    }

# ---------- HTML TEMPLATES ----------
PAGE_TMPL = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fantasy Football Start Sit Week {W} · FREE Start/Sit, Projections & Advice</title>
  <meta name="description" content="Who should I start in fantasy football Week {W}? FREE start/sit answers for every team’s QB, RB, WR, TE, K and D/ST. ESPN-compatible tools, projections, FMV and matchup context.">
  <link rel="canonical" href="{CANON}" />
  <style>
    body {{ font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height:1.55; margin:0; padding:24px; max-width: 1024px; }}
    header h1 {{ margin:0 0 8px; }}
    .muted {{ opacity:.85; }}
    ul {{ padding-left: 1.1rem; }}
    li {{ margin: 10px 0; }}
    details {{ border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; margin: 16px 0; }}
    summary {{ font-weight: 700; cursor: pointer; }}
    nav a {{ margin-right: 10px; }}
    footer {{ margin-top: 28px; font-size: 13px; opacity:.8; }}
    @media (prefers-color-scheme: dark) {{
      body {{ background:#0b0b0b; color:#e9e9e9; }}
      details {{ border-color:#2b2b2b; }}
    }}
  </style>
  <script type="application/ld+json" id="faq-jsonld">
  {FAQ_JSON}
  </script>
</head>
<body>
  <header>
    <a href="{HOME}" aria-label="Back to homepage">← Home</a>
    <h1>Fantasy Football Start/Sit — Week {W} (FREE)</h1>
    <p class="muted">ESPN-compatible · FREE start/sit tool · QB · RB · WR · TE · K · D/ST · Projections · FMV</p>
    <nav>
      <a href="/lineup-optimizer">Lineup Optimizer</a>
      <a href="/waiver-wire">Waiver Wire</a>
      <a href="/bye-week-planner">Bye Week Planner</a>
      <a href="/trade-calculator">Trade Calculator</a>
      <a href="/projections">Projections</a>
    </nav>
  </header>

  <main>
    <h2>Week {W} Start/Sit Questions (All Starters · All Teams)</h2>
    <ul>
      <li>
        {BIG_Q_BLOCK}
      </li>
    </ul>

    <details>
      <summary>Who We Are</summary>
      <p>Fortified Fantasy by Chad (<a href="https://allthingschad.com" target="_blank" rel="noopener">allthingschad.com</a>) — a FREE, ESPN-compatible toolkit to optimize lineups, waivers, trades, and bye weeks.</p>
    </details>

    <details>
      <summary>What Else?</summary>
      <ul>
        <li><a href="/lineup-optimizer">Free Lineup Optimizer (ESPN)</a></li>
        <li><a href="/waiver-wire">Free Waiver Wire &amp; Free-Agent Suggestions</a></li>
        <li><a href="/bye-week-planner">Free Bye Week Planner</a></li>
        <li><a href="/trade-calculator">Free Trade Calculator &amp; FMV</a></li>
        <li><a href="/projections">Weekly Projections &amp; Rankings</a></li>
      </ul>
    </details>

    <nav class="muted">Weeks:
      {WEEKS_NAV}
    </nav>
  </main>

  <footer>
    <p>&copy; {YEAR} Fortified Fantasy — Free Fantasy Football Tools</p>
  </footer>
</body>
</html>
"""

HUB_TMPL = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fantasy Football Start/Sit Hub · Weeks 1–14 (FREE)</title>
  <meta name="description" content="Find Week 1–14 start/sit FAQs for every NFL starter at QB, RB, WR, TE, K and D/ST. Free ESPN-compatible tools and projections." />
  <link rel="canonical" href="/start-sit/" />
  <style>
    body {{ font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height:1.55; margin:0; padding:24px; max-width:980px }}
    header h1 {{ margin:0 0 8px; }}
    .grid {{ display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:12px; }}
    a.card {{ display:block; border:1px solid #e5e7eb; border-radius:12px; padding:12px; text-decoration:none; color:inherit }}
    a.card:hover {{ background:#fafafa }}
    @media (prefers-color-scheme: dark) {{
      body {{ background:#0b0b0b; color:#e9e9e9 }}
      a.card {{ border-color:#2b2b2b; }}
      a.card:hover {{ background:#141414; }}
    }}
  </style>
</head>
<body>
  <header>
    <a href="{HOME}" aria-label="Back to homepage">← Home</a>
    <h1>Start/Sit Hub (Weeks 1–14)</h1>
    <p>Pick a week to view SEO-friendly FAQs covering every team’s starters (QB · RB · WR · TE · K · D/ST).</p>
  </header>
  <main>
    <div class="grid">
      {CARDS}
    </div>
  </main>
</body>
</html>
"""

# ---------- WRITE PAGES ----------
def write_week_page(week: int, depths):
    week_dir = OUT_WEEKS / f"week{week}"
    week_dir.mkdir(parents=True, exist_ok=True)

    big = build_big_li_block(depths, week)
    faq_json = build_faq_json(depths, week)

    html = PAGE_TMPL.format(
        W=week,
        HOME=HOMEPAGE_URL,
        CANON=canonical(f"/start-sit/week{week}/"),
        BIG_Q_BLOCK=big,
        WEEKS_NAV=weeks_nav_html(week),
        YEAR=datetime.utcnow().year,
        FAQ_JSON=json.dumps(faq_json, ensure_ascii=False, separators=(",",":"))
    )
    (week_dir / "index.html").write_text(html, encoding="utf-8")

def write_hub():
    cards = []
    for w in WEEKS:
        cards.append(f'<a class="card" href="/start-sit/week{w}/"><strong>Week {w}</strong><br><span>QB · RB · WR · TE · K · D/ST</span></a>')
    html = HUB_TMPL.format(CARDS="\n      ".join(cards), HOME=HOMEPAGE_URL)
    (OUT_WEEKS / "index.html").write_text(html, encoding="utf-8")

def write_sitemap():
    urls = [
        f"{SITE_ORIGIN}{HOMEPAGE_URL}",
        f"{SITE_ORIGIN}/start-sit/"
    ] + [f"{SITE_ORIGIN}/start-sit/week{w}/" for w in WEEKS]

    now = datetime.utcnow().strftime("%Y-%m-%d")
    items = [f"<url><loc>{u}</loc><lastmod>{now}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>" for u in urls]
    xml = f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "\n".join(items) + "\n</urlset>\n"
    (OUT_ROOT / "sitemap.xml").write_text(xml, encoding="utf-8")

def maybe_write_robots():
    if not GENERATE_ROBOTS:
        return
    robots = textwrap.dedent(f"""\
    User-agent: *
    Allow: /

    Sitemap: {SITE_ORIGIN}/sitemap.xml
    """)
    (OUT_ROOT / "robots.txt").write_text(robots, encoding="utf-8")

# ---------- MAIN ----------
def main():
    depths = load_depths_from_your_file(DATA_FILE)

    # Optional sanity print
    print(f"Parsed teams: {len(depths)}")
    if depths:
        print(f"Example: {depths[0]['team']} -> {depths[0]['slots']}")

    write_hub()
    for w in WEEKS:
        write_week_page(w, depths)

    write_sitemap()
    maybe_write_robots()

    print("✅ Generated /start-sit/week1..week14/, /start-sit/index.html, /sitemap.xml", end="")
    if GENERATE_ROBOTS:
        print(", /robots.txt")
    else:
        print()
    print(f"Source: {DATA_FILE}")

if __name__ == "__main__":
    main()
