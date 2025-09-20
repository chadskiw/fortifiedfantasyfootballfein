#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mark_unused_files.py
Find files stamped with IN_USE: FALSE and prepend a marker line
so they show red in VS Code.
"""

from pathlib import Path

def mark_false_files(root: Path):
    count = 0
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        try:
            with p.open("r", encoding="utf-8", errors="ignore") as f:
                first_lines = [next(f, ""), next(f, "")]
        except Exception:
            continue

        # only proceed if file header contains IN_USE: FALSE
        if not any("IN_USE: FALSE" in line for line in first_lines):
            continue

        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        # avoid adding twice
        if text.startswith("CHECK THIS OUT"):
            continue

        new_text = "CHECK THIS OUT\n" + text
        p.write_text(new_text, encoding="utf-8")
        print(f"Marked: {p}")
        count += 1

    print(f"\nDone. Marked {count} files as CHECK THIS OUT")

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Mark files with IN_USE: FALSE at the top.")
    ap.add_argument("--root", default=".", help="Directory to scan (default: current dir)")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if not root.exists():
        print(f"Path not found: {root}")
    else:
        mark_false_files(root)
