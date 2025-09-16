#!/usr/bin/env python3
"""
FEIN PoolPosition Exporter — GUI
--------------------------------
A Tkinter interface that wraps the CLI exporter. Supports:
  - Season (default 2025)
  - Sizes (comma-separated)
  - Output CSV file picker
  - Optional custom SQL
  - Optional DATABASE_URL override (else uses env)
  - Test Connection / Run Export (threaded)
  - Log panel + friendly error explanations
  - Persist last-used inputs (export_pool_position_gui.json)

Requires:
  pip install psycopg2-binary certifi

Author: FEIN tooling
"""

import os
import sys
import csv
import json
import queue
import threading
import argparse
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from typing import Iterable, List, Tuple, Any

# --- DB deps
try:
    import psycopg2
    import psycopg2.extras
except Exception as e:
    tk.Tk().withdraw()
    messagebox.showerror(
        "Missing dependency",
        "psycopg2 is required.\n\nInstall with:\n\npip install psycopg2-binary"
    )
    raise

try:
    import certifi
except Exception:
    tk.Tk().withdraw()
    messagebox.showerror(
        "Missing dependency",
        "certifi is required (for SSL CA bundle on Windows).\n\nInstall with:\n\npip install certifi"
    )
    raise

DEFAULT_SEASON = 2025

DEFAULT_SQL = """
SELECT
  season,
  league_id,
  team_id,
  team_name,
  league_name,
  league_size,
  COALESCE(week_pts, 0)   AS week_pts,
  COALESCE(season_pts, 0) AS season_pts,
  COALESCE(rank, NULL)    AS rank,
  COALESCE(power_rank, 0) AS power_rank,
  COALESCE(owner, '')     AS owner,
  COALESCE(logo,  '')     AS logo
FROM pool_position_view
WHERE season = %(season)s
  AND league_size = ANY(%(sizes)s)
ORDER BY league_size, season DESC, season_pts DESC, week_pts DESC;
""".strip()

CSV_HEADER = [
    "season",
    "leagueId",
    "teamId",
    "teamName",
    "leagueName",
    "leagueSize",
    "weekPts",
    "seasonPts",
    "rank",
    "powerRank",
    "owner",
    "logo",
]

PREFS_FILE = os.path.join(os.path.dirname(__file__), "export_pool_position_gui.json")


# ----------------------- Shared non-UI helpers ----------------------- #
def parse_sizes(s: str) -> List[int]:
    if not s:
        return []
    out = []
    for part in s.replace(' ', '').split(','):
        if not part:
            continue
        try:
            out.append(int(part))
        except ValueError:
            raise ValueError(f"Invalid size value: {part!r}")
    return out


def get_conn(db_url_override: str | None = None):
    """
    Render PG on Windows: require TLS + provide CA bundle + keepalives.
    Reads DATABASE_URL (or override), else discrete DB_* vars.
    """
    def _connect(dsn: str = None, **kw):
        kw.setdefault("sslmode", "require")
        kw.setdefault("sslrootcert", certifi.where())
        kw.setdefault("keepalives", 1)
        kw.setdefault("keepalives_idle", 30)
        kw.setdefault("keepalives_interval", 10)
        kw.setdefault("keepalives_count", 5)
        return psycopg2.connect(dsn, **kw) if dsn else psycopg2.connect(**kw)

    url = (db_url_override or "").strip() or os.getenv("DATABASE_URL")
    if url:
        return _connect(url)

    host = os.getenv("DB_HOST")
    port = int(os.getenv("DB_PORT", "5432"))
    name = os.getenv("DB_NAME")
    user = os.getenv("DB_USER")
    pw   = os.getenv("DB_PASS")
    if not (host and name and user and pw):
        raise RuntimeError("Set DATABASE_URL (recommended) or DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASS")
    return _connect(host=host, port=port, dbname=name, user=user, password=pw)


def fetch_rows(conn, season: int, sizes: List[int], sql: str) -> Iterable[Tuple[Any, ...]]:
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute(sql, {"season": season, "sizes": sizes})
        for row in cur.fetchall():
            yield (
                int(row[0]),             # season
                str(row[1]),             # leagueId
                str(row[2]),             # teamId
                str(row[3] or "Team"),   # teamName
                str(row[4] or "League"), # leagueName
                int(row[5]),             # leagueSize
                float(row[6] or 0.0),    # weekPts
                float(row[7] or 0.0),    # seasonPts
                row[8] if row[8] is not None else "",  # rank
                float(row[9] or 0.0),    # powerRank
                str(row[10] or ""),      # owner
                str(row[11] or ""),      # logo
            )


def write_csv(path: str, rows: Iterable[Tuple[Any, ...]]) -> int:
    n = 0
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(CSV_HEADER)
        for r in rows:
            w.writerow(r)
            n += 1
    return n


def explain_error(err: Exception) -> str:
    """
    Converts common psycopg2/SSL errors into human-friendly guidance.
    """
    msg = str(err) or repr(err)
    low = msg.lower()

    # SSL handshake / CA issues
    if "ssl connection has been closed unexpectedly" in low:
        return (
            "The server closed the SSL handshake.\n\n"
            "Try these fixes:\n"
            "• Ensure your DATABASE_URL ends with '?sslmode=require'\n"
            "• Install certifi: pip install certifi\n"
            "• Network/VPN/antivirus may be inspecting TLS on port 5432 – try a different network"
        )

    if "certificate verify failed" in low or "ssl" in low and "verify" in low:
        return (
            "TLS certificate verification failed.\n\n"
            "Fixes:\n"
            "• Ensure certifi is installed (pip install certifi)\n"
            "• Use the full Render hostname exactly as provided in their dashboard\n"
            "• Keep sslmode=require (or verify-full if you prefer strict hostname checks)"
        )

    if "password authentication failed" in low:
        return (
            "Password authentication failed.\n\n"
            "Fixes:\n"
            "• Double-check username/password\n"
            "• If using DATABASE_URL, URL-encode special characters in the password (@ : / ? & #)"
        )

    if "named service not known" in low or "could not translate host name" in low or "getaddrinfo" in low:
        return (
            "Could not resolve database hostname.\n\n"
            "Fixes:\n"
            "• Verify the host in DATABASE_URL (copy/paste from provider)\n"
            "• Check your internet connection/DNS/VPN"
        )

    if "connection refused" in low or "timeout" in low:
        return (
            "Connection refused or timed out.\n\n"
            "Fixes:\n"
            "• Verify host/port (default 5432)\n"
            "• Allow outbound 5432 in firewall/AV\n"
            "• Try off VPN/corporate network"
        )

    if "permission denied" in low or "insufficient privilege" in low:
        return (
            "The DB user lacks privileges to read the table/view.\n\n"
            "Fixes:\n"
            "• Grant SELECT on pool_position_view (or your custom SQL’s tables)\n"
            "• Connect with a user that has the right privileges"
        )

    # Fallback to the raw message
    return msg


# ----------------------------- GUI App ----------------------------- #
class PoolExportGUI(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("FEIN PoolPosition Exporter")
        self.geometry("920x640")
        self.minsize(860, 560)

        # State
        self.queue = queue.Queue()
        self.worker = None

        # Vars
        self.var_season = tk.StringVar(value=str(DEFAULT_SEASON))
        self.var_sizes = tk.StringVar(value="6,8,10,12,14,16")
        self.var_outfile = tk.StringVar(value=os.path.join(os.path.expanduser("~"), "pool_backup.csv"))
        self.var_sql = tk.StringVar(value=DEFAULT_SQL)
        self.var_dburl = tk.StringVar(value="")  # optional override
        self.var_remember = tk.BooleanVar(value=True)

        self._load_prefs()

        self._build_ui()
        self._poll_queue()

    # ---------------- UI construction ---------------- #
    def _build_ui(self):
        pad = dict(padx=10, pady=6)

        container = ttk.Frame(self)
        container.pack(fill="both", expand=True)

        # Form grid
        frm = ttk.LabelFrame(container, text="Export Configuration")
        frm.pack(side="top", fill="x", padx=10, pady=10)

        # Season
        ttk.Label(frm, text="Season:").grid(row=0, column=0, sticky="w", **pad)
        e_season = ttk.Entry(frm, textvariable=self.var_season, width=12)
        e_season.grid(row=0, column=1, sticky="w", **pad)

        # Sizes
        ttk.Label(frm, text="League Sizes:").grid(row=0, column=2, sticky="w", **pad)
        e_sizes = ttk.Entry(frm, textvariable=self.var_sizes, width=24)
        e_sizes.grid(row=0, column=3, sticky="w", **pad)
        ttk.Label(frm, text="Example: 6,8,10,12,14,16").grid(row=0, column=4, sticky="w", **pad)

        # Outfile
        ttk.Label(frm, text="Output CSV:").grid(row=1, column=0, sticky="w", **pad)
        e_out = ttk.Entry(frm, textvariable=self.var_outfile, width=58)
        e_out.grid(row=1, column=1, columnspan=3, sticky="we", **pad)
        ttk.Button(frm, text="Browse…", command=self._choose_outfile).grid(row=1, column=4, sticky="w", **pad)

        # DB URL override
        ttk.Label(frm, text="DATABASE_URL (override, optional):").grid(row=2, column=0, sticky="w", **pad)
        e_db = ttk.Entry(frm, textvariable=self.var_dburl, width=80)
        e_db.grid(row=2, column=1, columnspan=4, sticky="we", **pad)
        ttk.Label(frm, text="If empty, the environment variable DATABASE_URL is used.").grid(row=3, column=1, columnspan=4, sticky="w", padx=10)

        # SQL (expandable)
        frm_sql = ttk.LabelFrame(container, text="Custom SQL (optional)")
        frm_sql.pack(side="top", fill="both", padx=10, pady=(0, 10), expand=True)

        self.txt_sql = tk.Text(frm_sql, height=8, wrap="word")
        self.txt_sql.pack(side="left", fill="both", expand=True, padx=10, pady=10)
        self.txt_sql.insert("1.0", self.var_sql.get())
        scr_sql = ttk.Scrollbar(frm_sql, orient="vertical", command=self.txt_sql.yview)
        scr_sql.pack(side="right", fill="y")
        self.txt_sql.configure(yscrollcommand=scr_sql.set)

        # Actions
        actions = ttk.Frame(container)
        actions.pack(side="top", fill="x", padx=10, pady=4)
        ttk.Button(actions, text="Test Connection", command=self._test_connection).pack(side="left")
        ttk.Button(actions, text="Run Export", command=self._run_export).pack(side="left", padx=8)
        ttk.Checkbutton(actions, text="Remember my inputs", variable=self.var_remember).pack(side="right")

        # Log panel
        frm_log = ttk.LabelFrame(container, text="Log / Status")
        frm_log.pack(side="top", fill="both", expand=True, padx=10, pady=(6, 10))
        self.txt_log = tk.Text(frm_log, height=10, wrap="word")
        self.txt_log.pack(side="left", fill="both", expand=True, padx=10, pady=10)
        scr = ttk.Scrollbar(frm_log, orient="vertical", command=self.txt_log.yview)
        scr.pack(side="right", fill="y")
        self.txt_log.configure(yscrollcommand=scr.set)

    # ---------------- Prefs ---------------- #
    def _load_prefs(self):
        try:
            if os.path.exists(PREFS_FILE):
                with open(PREFS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self.var_season.set(str(data.get("season", DEFAULT_SEASON)))
                self.var_sizes.set(data.get("sizes", "6,8,10,12,14,16"))
                self.var_outfile.set(data.get("outfile", self.var_outfile.get()))
                self.var_dburl.set(data.get("dburl", ""))
                self.var_sql.set(data.get("sql", DEFAULT_SQL))
        except Exception:
            pass

    def _save_prefs(self):
        if not self.var_remember.get():
            return
        try:
            data = {
                "season": int(self.var_season.get() or DEFAULT_SEASON),
                "sizes": self.var_sizes.get(),
                "outfile": self.var_outfile.get(),
                "dburl": self.var_dburl.get(),
                "sql": self.txt_sql.get("1.0", "end").strip(),
            }
            with open(PREFS_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception:
            pass

    # ---------------- UI helpers ---------------- #
    def _append_log(self, text: str):
        self.txt_log.insert("end", text.rstrip() + "\n")
        self.txt_log.see("end")

    def _choose_outfile(self):
        path = filedialog.asksaveasfilename(
            title="Choose output CSV",
            defaultextension=".csv",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
        )
        if path:
            self.var_outfile.set(path)

    # ---------------- Workers ---------------- #
    def _poll_queue(self):
        try:
            while True:
                msg, level = self.queue.get_nowait()
                if level == "error":
                    self._append_log("ERROR: " + msg)
                    messagebox.showerror("Error", msg)
                elif level == "warn":
                    self._append_log("WARN: " + msg)
                else:
                    self._append_log(msg)
        except queue.Empty:
            pass
        self.after(100, self._poll_queue)

    def _start_worker(self, target, *args):
        if self.worker and self.worker.is_alive():
            messagebox.showwarning("Busy", "Please wait—an operation is already running.")
            return
        self.worker = threading.Thread(target=target, args=args, daemon=True)
        self.worker.start()

    def _test_connection(self):
        def work():
            try:
                self.queue.put(("Testing connection…", "info"))
                dburl = self.var_dburl.get().strip() or os.getenv("DATABASE_URL") or ""
                if not dburl:
                    self.queue.put((
                        "DATABASE_URL not set (and no override provided). "
                        "Set it or paste a temporary override in the field above.", "warn"
                    ))
                conn = get_conn(dburl)
                with conn:
                    with conn.cursor() as cur:
                        cur.execute("SELECT current_database(), current_user, version();")
                        row = cur.fetchone()
                conn.close()
                self.queue.put((f"Connection OK → DB: {row[0]} · User: {row[1]}", "info"))
                self.queue.put(("Server: " + str(row[2]).split('\n')[0], "info"))
            except Exception as e:
                self.queue.put((explain_error(e), "error"))

        self._start_worker(work)

    def _run_export(self):
        def work():
            try:
                self._save_prefs()
                season = int(self.var_season.get() or DEFAULT_SEASON)
                sizes = parse_sizes(self.var_sizes.get())
                if not sizes:
                    raise ValueError("No league sizes provided (e.g., 6,8,10,12,14,16)")
                outfile = self.var_outfile.get().strip()
                if not outfile:
                    raise ValueError("Please choose an output CSV path")

                sql = self.txt_sql.get("1.0", "end").strip() or DEFAULT_SQL
                dburl = self.var_dburl.get().strip() or os.getenv("DATABASE_URL") or ""

                self.queue.put((f"Connecting to database…", "info"))
                conn = get_conn(dburl)

                try:
                    self.queue.put((f"Querying data for season={season}, sizes={sizes}…", "info"))
                    rows = list(fetch_rows(conn, season, sizes, sql))
                finally:
                    conn.close()

                self.queue.put((f"Writing CSV → {outfile}", "info"))
                count = write_csv(outfile, rows)
                self.queue.put((f"Done. Wrote {count} rows.", "info"))
                if count == 0:
                    self.queue.put(("NOTE: 0 rows exported. Verify your SQL/view and inputs.", "warn"))
            except Exception as e:
                self.queue.put((explain_error(e), "error"))

        self._start_worker(work)


if __name__ == "__main__":
    app = PoolExportGUI()
    app.mainloop()
