import tkinter as tk
from tkinter import filedialog, messagebox
import subprocess
import sys
import os
from dotenv import load_dotenv
load_dotenv()

def run_script():
    season = entry_season.get().strip()
    scoring = scoring_var.get()
    start = entry_start.get().strip()
    end = entry_end.get().strip()
    outdir = entry_outdir.get().strip()

    if not season or not scoring:
        messagebox.showerror("Error", "Season and scoring type are required")
        return

    cmd = [
        sys.executable,  # current python
        os.path.join(os.path.dirname(__file__), "playerPointsByWeek.py"),
        season, scoring
    ]
    if start: cmd += ["--start", start]
    if end: cmd += ["--end", end]
    if outdir: cmd += ["--outdir", outdir]

    try:
        subprocess.run(cmd, check=True)
        messagebox.showinfo("Success", f"CSV created in {outdir or 'current folder'}")
    except subprocess.CalledProcessError as e:
        messagebox.showerror("Run Failed", str(e))

root = tk.Tk()
root.title("Player Points Exporter")

tk.Label(root, text="Season:").grid(row=0, column=0, sticky="e")
entry_season = tk.Entry(root)
entry_season.grid(row=0, column=1)

tk.Label(root, text="Scoring:").grid(row=1, column=0, sticky="e")
scoring_var = tk.StringVar(value="PPR")
tk.OptionMenu(root, scoring_var, "STD", "HALF", "PPR").grid(row=1, column=1)

tk.Label(root, text="Start Week:").grid(row=2, column=0, sticky="e")
entry_start = tk.Entry(root)
entry_start.grid(row=2, column=1)

tk.Label(root, text="End Week:").grid(row=3, column=0, sticky="e")
entry_end = tk.Entry(root)
entry_end.grid(row=3, column=1)

tk.Label(root, text="Output Folder:").grid(row=4, column=0, sticky="e")
entry_outdir = tk.Entry(root)
entry_outdir.grid(row=4, column=1)
tk.Button(root, text="Browse", command=lambda: entry_outdir.insert(0, filedialog.askdirectory())).grid(row=4, column=2)

tk.Button(root, text="Run Export", command=run_script).grid(row=5, column=0, columnspan=3, pady=10)

root.mainloop()
