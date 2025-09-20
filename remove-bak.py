#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
remove_bak_files.py
Recursively delete all .bak files under a given directory.
"""

import os
from pathlib import Path

def remove_bak_files(root: Path):
    count = 0
    for p in root.rglob("*.bak"):
        try:
            p.unlink()
            print(f"Deleted: {p}")
            count += 1
        except Exception as e:
            print(f"Error deleting {p}: {e}")
    print(f"\nDone. Removed {count} .bak files under {root}")

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Remove all .bak files recursively.")
    ap.add_argument("--root", default=".", help="Directory to clean (default: current dir)")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if not root.exists():
        print(f"Path does not exist: {root}")
    else:
        remove_bak_files(root)
