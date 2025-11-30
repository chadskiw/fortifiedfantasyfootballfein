#!/usr/bin/env python3
# TRUE_LOCATION: scripts/system-walker.py
# IN_USE: FALSE
# -*- coding: utf-8 -*-
"""
stamp_and_walk.py
Adds TRUE_LOCATION / IN_USE, writes system-walk-results.txt, and includes a GUI with:
- Root directory chooser
- Add/remove scan directories
- Rescan
- Delete unused (to trash by default, or permanently if enabled)

Changes from previous version:
- No .bak backups are created when stamping.
- ONLY unused files are "backed up" by RENAMING the file itself to *.bak (collision-safe).
"""

import argparse, os, re, sys, shutil
from pathlib import Path
from html.parser import HTMLParser
import ast
from collections import defaultdict, deque

# ---------------- Comment styles ----------------
COMMENT_STYLES = {
    ".js": ("// ", ""), ".jsx": ("// ", ""), ".ts": ("// ", ""), ".tsx": ("// ", ""),
    ".mjs": ("// ", ""), ".cjs": ("// ", ""),
    ".c": ("// ", ""), ".cpp": ("// ", ""), ".h": ("// ", ""), ".hpp": ("// ", ""),
    ".java": ("// ", ""), ".cs": ("// ", ""),
    ".py": ("# ", ""), ".sh": ("# ", ""), ".rb": ("# ", ""), ".pl": ("# ", ""), ".ps1": ("# ", ""),
    ".css": ("/* ", " */"), ".scss": ("/* ", " */"), ".less": ("/* ", " */"),
    ".html": ("<!-- ", " -->"), ".htm": ("<!-- ", " -->"),
    ".php": ("// ", ""),
    ".yml": ("# ", ""), ".yaml": ("# ", ""), ".toml": ("# ", ""),
    ".ini": ("; ", ""), ".cfg": ("# ", ""), ".env": ("# ", ""),
    ".sql": ("-- ", ""), ".md": ("<!-- ", " -->"),
}
UNCOMMENTABLE = {".json"}
import fnmatch

BAK_RE = re.compile(r"\.bak(\d+)?$", re.IGNORECASE)

def is_bak(path: Path) -> bool:
    return bool(BAK_RE.search(path.name))

def vsc_sort(paths, root: Path):
    # Approx VS Code default: case-insensitive, by relative path
    return sorted(paths, key=lambda p: norm_rel(root, p).lower())

# ---------------- Helpers ----------------
def build_comment(ext: str, key: str, value: str) -> str:
    pre, suf = COMMENT_STYLES[ext]
    return f"{pre}{key}: {value}{suf}\n"

def detect_style(path: Path):
    ext = path.suffix.lower()
    return COMMENT_STYLES.get(ext), ext

def is_binary(path: Path, sniff=2048) -> bool:
    try:
        with path.open("rb") as f:
            chunk = f.read(sniff)
        if b"\x00" in chunk:
            return True
        chunk.decode("utf-8")
        return False
    except Exception:
        return True

def norm_rel(root: Path, target: Path) -> str:
    return os.path.relpath(target, root).replace("\\", "/")

def looks_relative(s: str) -> bool:
    return s.startswith("./") or s.startswith("../") or s.startswith("/")

def resolve_relative(base_file: Path, rel: str, root: Path):
    rel = rel.split("#", 1)[0].split("?", 1)[0]
    if rel.startswith("/"):
        candidate = (root / rel.lstrip("/")).resolve()
        return try_extensions(candidate)
    candidate = (base_file.parent / rel).resolve()
    return try_extensions(candidate)

COMMON_EXTS = ["", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
               ".css", ".scss", ".less", ".html", ".htm", ".py"]
def try_extensions(path: Path):
    if path.is_file():
        return path
    for ext in COMMON_EXTS:
        p = Path(str(path) + ext)
        if p.is_file():
            return p
    if path.is_dir():
        for ext in [".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".html", ".htm", ".py"]:
            p = path / f"index{ext}"
            if p.is_file():
                return p
    return None

def safe_bak_path(path: Path) -> Path:
    """Return a non-conflicting *.bak path, e.g. file.ext.bak, file.ext.bak2, ..."""
    base = path.with_suffix(path.suffix + ".bak")
    if not base.exists():
        return base
    n = 2
    while True:
        cand = path.with_suffix(path.suffix + f".bak{n}")
        if not cand.exists():
            return cand
        n += 1

# ---------------- Edge extractors ----------------
JS_IMPORT_RE = re.compile(r"""(?x)(?:import\s+[^'"]*from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]""")
CSS_IMPORT_RE = re.compile(r"""@import\s+(?:url\()?['"]?([^'")]+)['"]?\)?""", re.IGNORECASE)
CSS_URL_RE    = re.compile(r"""url\(\s*['"]?([^'")]+)['"]?\s*\)""", re.IGNORECASE)

class SimpleHTMLRefParser(HTMLParser):
    def __init__(self): super().__init__(); self.refs=[]
    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        for key in ("src","href","data-src","poster"):
            if key in d: self.refs.append(d[key])

def extract_edges_for_file(path: Path, root: Path):
    ext = path.suffix.lower()
    edges = []
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return edges

    if ext in {".js",".jsx",".ts",".tsx",".mjs",".cjs"}:
        for m in JS_IMPORT_RE.finditer(text):
            spec = m.group(1).strip()
            if looks_relative(spec):
                tgt = resolve_relative(path, spec, root)
                if tgt: edges.append(tgt)

    elif ext == ".py":
        try:
            tree = ast.parse(text, filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.level and node.module:
                    rel = "./" + node.module.replace(".", "/")
                    tgt = resolve_relative(path, rel + ".py", root) or resolve_relative(path, rel, root)
                    if tgt: edges.append(tgt)
        except Exception:
            for m in re.finditer(r"from\s+(\.+[a-zA-Z0-9_\.]+)\s+import\s+", text):
                module = m.group(1).strip(".").replace(".", "/")
                rel = "./" + module
                tgt = resolve_relative(path, rel + ".py", root) or resolve_relative(path, rel, root)
                if tgt: edges.append(tgt)

    elif ext in {".html",".htm"}:
        parser = SimpleHTMLRefParser()
        try:
            parser.feed(text)
            for ref in parser.refs:
                if looks_relative(ref):
                    tgt = resolve_relative(path, ref, root)
                    if tgt: edges.append(tgt)
        except Exception:
            pass

    elif ext in {".css",".scss",".less"}:
        for m in CSS_IMPORT_RE.finditer(text):
            spec = m.group(1).strip()
            if looks_relative(spec):
                tgt = resolve_relative(path, spec, root)
                if tgt: edges.append(tgt)
        for m in CSS_URL_RE.finditer(text):
            spec = m.group(1).strip()
            if looks_relative(spec):
                tgt = resolve_relative(path, spec, root)
                if tgt: edges.append(tgt)
    return edges

# ---------------- Graph + reachability ----------------
def detect_roots(root: Path, scan_dirs):
    candidates = [
        "index.html","public/index.html","web/index.html","frontend/index.html",
        "server.js","api/server.js","app.js","main.js",
        "main.tsx","src/main.tsx","src/index.tsx",
        "app.py","wsgi.py","run.py",
    ]
    roots=[]
    for c in candidates:
        p = (root / c)
        if p.exists(): roots.append(p.resolve())
    for d in scan_dirs:
        d = d.resolve()
        if d.is_dir():
            for name in ("index.html","index.htm"):
                p = d / name
                if p.exists(): roots.append(p.resolve())
    return list(dict.fromkeys(roots))

def build_graph(root: Path, files):
    edges = defaultdict(set)
    for f in files:
        for dep in extract_edges_for_file(f, root):
            edges[f].add(dep)
    return edges

def reachable_from(graph, roots):
    seen=set(); q=deque()
    for r in roots:
        if r.exists(): seen.add(r); q.append(r)
    while q:
        cur=q.popleft()
        for nxt in graph.get(cur, ()):
            if nxt not in seen: seen.add(nxt); q.append(nxt)
    return seen

# ---------------- File stamping / renaming ----------------
def update_header_comments(path: Path, root: Path, in_use: bool, dry_run=False, no_backup=False):
    """
    - Used files: stamp TRUE_LOCATION and IN_USE without creating backups.
    - Unused files: rename file to *.bak (unless --no-backup), still try to stamp inside the renamed file if text.
    - Binary or uncommentable files: if unused, still rename to *.bak; otherwise skip.
    """
    # If unused, handle rename upfront (independent of commentability)
    if not in_use:
        if dry_run:
            return f"RENAME (dry-run):   {path} -> {path.with_suffix(path.suffix + '.bak')}"
        if no_backup:
            # Explicitly requested: do not rename even if unused
            # But still attempt stamping below if possible (so it gets IN_USE: FALSE)
            pass
        else:
            # Perform rename for unused files
            try:
                dest = safe_bak_path(path)
                dest.parent.mkdir(parents=True, exist_ok=True)
                path.rename(dest)
                path = dest  # work on the renamed file from here on
            except Exception as e:
                return f"ERROR (rename):     {path} ({e})"

    style, ext = detect_style(path)
    # Binary or un-commentable handling
    if not style or is_binary(path) or ext in UNCOMMENTABLE:
        # If file is unused and we got here, rename already done (unless no_backup or dry_run)
        if not in_use:
            if no_backup:
                return f"SKIP (unused, no-rename due to --no-backup): {path}"
            return f"RENAMED (unused):   {path}"
        # Used but we can't stamp
        if not style:
            return f"SKIP (unknown ext): {path}"
        if is_binary(path):
            return f"SKIP (binary):      {path}"
        if ext in UNCOMMENTABLE:
            return f"SKIP (no comments): {path}"

    # From here: text + commentable
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return f"SKIP (decode UTF-8): {path}"
    except Exception as e:
        return f"ERROR (read):        {path} ({e})"

    rel = norm_rel(root, path)
    desired_true = build_comment(ext, "TRUE_LOCATION", rel)
    desired_use  = build_comment(ext, "IN_USE", "TRUE" if in_use else "FALSE")

    lines = text.splitlines(keepends=True)
    has_shebang = bool(lines and lines[0].lstrip().startswith("#!"))
    base_idx = 1 if has_shebang else 0

    def ensure_line(lines_list, idx, key_comment):
        if idx >= len(lines_list):
            lines_list.append(key_comment); return True
        existing = lines_list[idx]
        if f"{key_comment.split(':',1)[0]}:" in existing:
            if existing.strip()!=key_comment.strip():
                lines_list[idx]=key_comment; return True
            return False
        lines_list[idx:idx]=[key_comment]; return True

    new_lines = list(lines)
    changed = False
    changed |= ensure_line(new_lines, base_idx, desired_true)
    use_idx = base_idx + 1
    changed |= ensure_line(new_lines, use_idx, desired_use)

    if not changed:
        # If we reached here with unused & renamed, reflect that
        return (f"OK (up-to-date):    {path}  IN_USE={'TRUE' if in_use else 'FALSE'}")
    if dry_run:
        return f"WRITE (dry-run):    {path}  IN_USE={'TRUE' if in_use else 'FALSE'}"

    try:
        path.write_text("".join(new_lines), encoding="utf-8")
        # Clarify if this was a rename path for unused
        return f"WROTE:              {path}  IN_USE={'TRUE' if in_use else 'FALSE'}"
    except Exception as e:
        return f"ERROR (write):      {path} ({e})"

# ---------------- Report building ----------------
def list_tree(root: Path, used_files):
    used_rel = sorted(norm_rel(root, f) for f in used_files)
    tree = []
    prev_parts = []
    for rel in used_rel:
        parts = rel.split("/")
        i=0
        while i < min(len(parts), len(prev_parts)) and parts[i]==prev_parts[i]:
            i+=1
        for j in range(i, len(parts)):
            indent = "  " * j
            tree.append(f"{indent}{parts[j]}")
        prev_parts = parts
    return "\n".join(tree) if tree else "(none)"

def categorize_folders(root: Path, all_files, used_files, scan_dirs):
    all_files_set = set(all_files)
    used_set = set(used_files)
    unused_set = all_files_set - used_set

    dir_files = defaultdict(set)
    for f in all_files_set:
        d = f.parent
        while True:
            if any(str(d).startswith(str(sd)) for sd in scan_dirs):
                dir_files[d].add(f)
            if d == d.parent: break
            d = d.parent

    unnecessary = []
    keep = []
    for d, files in dir_files.items():
        if not files: continue
        if files.issubset(unused_set):
            unnecessary.append(d)
        elif any(f in used_set for f in files) and any(f in unused_set for f in files):
            keep.append(d)

    unnecessary = sorted(set(unnecessary), key=lambda p: norm_rel(root, p))
    keep        = sorted(set(keep), key=lambda p: norm_rel(root, p))
    return unnecessary, keep, sorted(unused_set, key=lambda p: norm_rel(root, p))

def write_results_file(root: Path, used_files, unnecessary_dirs, keep_dirs, other_unused_files):
    out = []
    out.append("# System Walk Results\n")
    out.append("## Section 1 — Used files (directory tree)\n")
    out.append(list_tree(root, used_files) + "\n")
    out.append("## Section 2 — Unnecessary folders (all files unused)\n")
    if unnecessary_dirs:
        for d in unnecessary_dirs:
            out.append(f"- {norm_rel(root, d)}")
    else:
        out.append("(none)")
    out.append("\n## Section 3 — Keep folders (mixed; keep at least listed used files)\n")
    if keep_dirs:
        for d in keep_dirs:
            out.append(f"- {norm_rel(root, d)}")
    else:
        out.append("(none)")
    out.append("\n## Section 4 — Other unused files (deletable candidates)\n")
    if other_unused_files:
        for f in other_unused_files:
            out.append(f"- {norm_rel(root, f)}")
    else:
        out.append("(none)")
    (root / "system-walk-results.txt").write_text("\n".join(out) + "\n", encoding="utf-8")
def print_graph_report_stdout(root: Path, used_files, unnecessary_dirs, keep_dirs, other_unused_files):
    print("# System Walk Results (STDOUT)\n")
    print("## Section 1 — Used files (directory tree)")
    print(list_tree(root, used_files) or "(none)")
    print("\n## Section 2 — Unnecessary folders (all files unused)")
    if unnecessary_dirs:
        for d in unnecessary_dirs:
            print(f"- {norm_rel(root, d)}")
    else:
        print("(none)")
    print("\n## Section 3 — Keep folders (mixed; keep at least listed used files)")
    if keep_dirs:
        for d in keep_dirs:
            print(f"- {norm_rel(root, d)}")
    else:
        print("(none)")
    print("\n## Section 4 — Other unused files (VS Code order)")
    if other_unused_files:
        for f in vsc_sort(other_unused_files, root):
            print(f"- {norm_rel(root, f)}")
    else:
        print("(none)")


def print_fs_tree_stdout(root: Path, scan_dirs, include_hidden: bool):
    """
    No reachability analysis; just list everything we see.
    Show a directory tree of all non-.bak files, then a separate list of .bak files.
    """
    def should_visit(p: Path):
        name = p.name
        if not include_hidden and name.startswith('.'):
            return False
        return True

    all_files = []
    for base in scan_dirs:
        for p in base.rglob("*"):
            if p.is_dir():
                if not should_visit(p): continue
                continue
            if not should_visit(p): continue
            all_files.append(p.resolve())
    all_files = list(dict.fromkeys(all_files))

    non_bak = [p for p in all_files if not is_bak(p)]
    bak_only = [p for p in all_files if is_bak(p)]

    # Build a tree from non-bak files
    print("# Filesystem View (STDOUT)\n")
    print("## Section A — Directory tree (non-.bak files)")
    print(list_tree(root, non_bak) or "(none)")

    print("\n## Section B — .bak files (VS Code order)")
    if bak_only:
        for p in vsc_sort(bak_only, root):
            print(f"- {norm_rel(root, p)}")
    else:
        print("(none)")

# ---------------- Compute (shared) ----------------
def compute_results(root: Path, scan_dirs, allowed_exts, roots_cli=None, include_hidden=False, dry_run=False, no_backup=False):
    def should_visit(p: Path):
        name = p.name
        if not include_hidden and name.startswith('.'): return False
        return True

    # Collect files
    files=[]
    for base in scan_dirs:
        for p in base.rglob("*"):
            if p.is_dir():
                if not should_visit(p): continue
                continue
            if not should_visit(p): continue
            if p.suffix.lower() in allowed_exts:
                files.append(p.resolve())
    files = list(dict.fromkeys(files))

    # Roots
    if roots_cli:
        explicit_roots=[]
        for r in roots_cli:
            rp = Path(r)
            if not rp.is_absolute(): rp = (root / r)
            if rp.exists(): explicit_roots.append(rp.resolve())
        roots = explicit_roots
    else:
        roots = detect_roots(root, scan_dirs)
        if not roots:
            html_roots = [f for f in files if f.suffix.lower() in (".html",".htm")]
            roots = html_roots[:10]

    # Graph/reachability
    graph = build_graph(root, files)
    used = reachable_from(graph, roots)

    # Stamp or rename
    for f in files:
        in_use = f in used
        msg = update_header_comments(f, root, in_use, dry_run=dry_run, no_backup=no_backup)
        print(msg)

    unnecessary_dirs, keep_dirs, other_unused_files = categorize_folders(root, files, used, scan_dirs)
    write_results_file(root, used_files=sorted(used), unnecessary_dirs=unnecessary_dirs,
                       keep_dirs=keep_dirs, other_unused_files=other_unused_files)
    return files, used, unnecessary_dirs, keep_dirs, other_unused_files

# ---------------- GUI (with directory chooser) ----------------
def launch_gui(root: Path, scan_dirs, allowed_exts, roots_cli=None):
    import tkinter as tk
    from tkinter import ttk, messagebox, filedialog

    # current, mutable selections
    current_root = Path(root)
    current_scan_dirs = [Path(d) for d in scan_dirs]

    # Run an initial compute
    def run_compute_and_refresh():
        # ensure dirs exist
        valid_scan = [d for d in current_scan_dirs if d.exists() and d.is_dir()]
        files, used, unnecessary_dirs, keep_dirs, other_unused_files = compute_results(
            current_root, valid_scan, allowed_exts, roots_cli=roots_cli, include_hidden=False, dry_run=False, no_backup=False
        )
        # refresh lists
        for w in (files_list, dirs_list):
            for child in w.get_children():
                w.delete(child)

        # Fill unused files (note: many will have been renamed to .bak and thus drop out on next scan)
        for p in other_unused_files:
            files_list.insert("", "end", values=(str(p),))

        # Fill unnecessary dirs
        for d in unnecessary_dirs:
            dirs_list.insert("", "end", values=(str(d),))

        # Update labels
        root_label_var.set(f"Root: {current_root}")
        scans_label_var.set("Scan dirs:\n" + ("\n".join(str(d) for d in valid_scan) if valid_scan else "(none)"))

    # UI
    win = tk.Tk()
    win.title("System Walk — Choose Dirs / Delete Unused")
    win.geometry("1000x650")

    topbar = ttk.Frame(win); topbar.pack(fill="x", padx=10, pady=8)
    root_label_var = tk.StringVar(value=f"Root: {current_root}")
    ttk.Label(topbar, textvariable=root_label_var).pack(side="left")

    def choose_root():
        new = filedialog.askdirectory(title="Choose project root", initialdir=str(current_root))
        if new:
            current_root = Path(new).resolve()
            run_compute_and_refresh()

    ttk.Button(topbar, text="Change root…", command=choose_root).pack(side="left", padx=8)

    scans_label_var = tk.StringVar(value="Scan dirs:\n" + "\n".join(str(d) for d in current_scan_dirs))
    scans_box = ttk.Label(win, textvariable=scans_label_var, anchor="w", justify="left")
    scans_box.pack(fill="x", padx=10)

    toolbar = ttk.Frame(win); toolbar.pack(fill="x", padx=10, pady=4)
    def add_scan_dir():
        d = filedialog.askdirectory(title="Add scan directory", initialdir=str(current_root))
        if d:
            dpath = Path(d).resolve()
            if dpath not in current_scan_dirs:
                current_scan_dirs.append(dpath)
                run_compute_and_refresh()

    def remove_scan_dir():
        if not current_scan_dirs:
            messagebox.showinfo("No scan dirs", "There are no scan directories to remove.")
            return
        choices = tk.Toplevel(win)
        choices.title("Remove scan directories")
        choices.geometry("500x300")
        lb = tk.Listbox(choices, selectmode="extended")
        for i,d in enumerate(current_scan_dirs):
            lb.insert(i, str(d))
        lb.pack(fill="both", expand=True, padx=8, pady=8)
        def do_remove():
            sel = list(lb.curselection())
            if not sel:
                choices.destroy(); return
            for idx in sorted(sel, reverse=True):
                current_scan_dirs.pop(idx)
            choices.destroy()
            run_compute_and_refresh()
        ttk.Button(choices, text="Remove selected", command=do_remove).pack(pady=6)
        ttk.Button(choices, text="Cancel", command=choices.destroy).pack(pady=2)

    ttk.Button(toolbar, text="Add scan dir…", command=add_scan_dir).pack(side="left")
    ttk.Button(toolbar, text="Remove scan dir…", command=remove_scan_dir).pack(side="left", padx=6)
    ttk.Button(toolbar, text="Rescan / Restamp", command=run_compute_and_refresh).pack(side="left", padx=12)

    # Panes
    pane = ttk.Panedwindow(win, orient=tk.HORIZONTAL); pane.pack(fill="both", expand=True, padx=10, pady=10)

    # Left: Unused files
    left = ttk.Labelframe(pane, text="Other unused files (deletable candidates)")
    pane.add(left, weight=3)
    files_list = ttk.Treeview(left, columns=("path",), show="headings", height=18)
    files_list.heading("path", text="File path")
    files_list.pack(fill="both", expand=True)

    # Right: Unnecessary folders
    right = ttk.Labelframe(pane, text="Unnecessary folders (all files unused)")
    pane.add(right, weight=2)
    dirs_list = ttk.Treeview(right, columns=("path",), show="headings", height=18)
    dirs_list.heading("path", text="Folder path")
    dirs_list.pack(fill="both", expand=True)

    # Delete controls
    bottom = ttk.Frame(win); bottom.pack(fill="x", padx=10, pady=8)
    permanent_var = tk.BooleanVar(value=False)
    ttk.Checkbutton(bottom, text="Permanently delete (irreversible)", variable=permanent_var).pack(side="left")

    def ensure_trash():
        trash = current_root / ".system-walk-trash"
        trash.mkdir(exist_ok=True)
        return trash

    def move_to_trash(path: Path):
        trash = ensure_trash()
        dest = trash / path.relative_to(current_root)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(dest))

    def gather_selected(tree):
        items = tree.selection()
        return [Path(tree.item(i, "values")[0]) for i in items]

    def do_delete():
        from tkinter import messagebox
        files_sel = gather_selected(files_list)
        dirs_sel  = gather_selected(dirs_list)
        if not files_sel and not dirs_sel:
            messagebox.showinfo("Nothing selected", "Select files/folders to delete from the lists.")
            return
        if not messagebox.askokcancel("Confirm", f"Delete {len(files_sel)} files and {len(dirs_sel)} folders?"):
            return
        perm = permanent_var.get()
        errors=[]
        for p in files_sel:
            try:
                if perm: p.unlink(missing_ok=True)
                else: move_to_trash(p)
            except Exception as e:
                errors.append(f"File {p}: {e}")
        for d in dirs_sel:
            try:
                if perm: shutil.rmtree(d, ignore_errors=False)
                else:
                    trash = ensure_trash()
                    dest = trash / d.relative_to(current_root)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(d), str(dest))
            except Exception as e:
                errors.append(f"Dir {d}: {e}")
        if errors:
            messagebox.showerror("Finished with errors", "\n".join(errors[:20]))
        else:
            messagebox.showinfo("Done", "Selected items processed.")
        run_compute_and_refresh()  # refresh after delete

    ttk.Button(bottom, text="Delete selected", command=do_delete).pack(side="right")
    ttk.Button(bottom, text="Close", command=win.destroy).pack(side="right", padx=8)

    # Initial compute + fill
    run_compute_and_refresh()
    win.mainloop()

# ---------------- Main ----------------
def main():
    ap = argparse.ArgumentParser(
        description="Stamp TRUE_LOCATION/IN_USE, write system-walk-results.txt, GUI with directory chooser."
    )
    ap.add_argument("--root", help="Project root for relative paths. Defaults to current working directory.")
    ap.add_argument("--dir", nargs="+", default=["."], help="Dirs to scan (one or many).")
    ap.add_argument("--ext", nargs="*", default=None, help="Limit to these extensions (e.g., .js .ts .tsx .py .html .css .scss .less)")
    ap.add_argument("--roots", nargs="*", default=None, help="Explicit entry files (relative to --root or absolute).")
    ap.add_argument("--dry-run", action="store_true", help="Show actions without writing file stamps / renames.")
    ap.add_argument("--no-backup", action="store_true", help="Do not rename unused files to .bak.")
    ap.add_argument("--include-hidden", action="store_true", help="Include dotfiles/dirs (only for CLI run).")
    ap.add_argument("--gui", action="store_true", help="Launch GUI with directory chooser and delete panel.")
    ap.add_argument("--yes", "-y", action="store_true", help="Do not prompt for confirmation; proceed immediately.")
    ap.add_argument("--report-only", action="store_true",
                    help="Do not modify anything; only compute and output a report.")
    ap.add_argument("--stdout", action="store_true",
                    help="Print the analytics report to STDOUT instead of writing a file.")
    ap.add_argument("--fs-tree", action="store_true",
                    help="Skip usage analysis and just show a filesystem tree with .bak files separated.")

   
    args = ap.parse_args()

    # Default root to current working directory when not provided
    root = Path(args.root).resolve() if args.root else Path.cwd().resolve()

    if not root.exists() or not root.is_dir():
        print(f"[fatal] --root not a directory: {root}", file=sys.stderr); sys.exit(2)

    # Normalize scan dirs relative to root (absolute inputs are respected)
    scan_dirs = [(root / d).resolve() if not os.path.isabs(d) else Path(d).resolve() for d in args.dir]
    for d in scan_dirs:
        if not d.exists() or not d.is_dir():
            print(f"[fatal] --dir not a directory: {d}", file=sys.stderr); sys.exit(2)

    allowed_exts = set(e.lower() for e in (args.ext or COMMENT_STYLES.keys()))

    # Confirmation prompt (unless --yes)
    if not args.yes:
        print("System Walker — Confirmation")
        print(f"  Root: {root}")
        print("  Scan dirs:")
        for d in scan_dirs:
            print(f"    - {d}")
        print(f"  Include hidden: {'yes' if args.include_hidden else 'no'}")
        print(f"  Dry run: {'yes' if args.dry_run else 'no'}")
        print(f"  No-backup (do NOT rename unused to .bak): {'yes' if args.no_backup else 'no'}")
        if args.gui:
            print("  Mode: GUI")
        else:
            print("  Mode: CLI")
        resp = input("Proceed? [y/N]: ").strip().lower()
        if resp not in ("y", "yes"):
            print("Aborted.")
            sys.exit(0)

    if args.gui:
        # GUI lets you choose root/dirs and handles rescans internally.
        launch_gui(root, scan_dirs, allowed_exts, roots_cli=args.roots)
        return

    if args.fs_tree:
        # Pure filesystem view: no stamping, no writing
        print_fs_tree_stdout(root, scan_dirs, include_hidden=args.include_hidden)
        return

    # Compute reachability
    files, used, unnecessary_dirs, keep_dirs, other_unused_files = compute_results(
        root, scan_dirs, allowed_exts,
        roots_cli=args.roots, include_hidden=args.include_hidden,
        dry_run=True if args.report_only else args.dry_run,   # ensure no changes when --report-only
        no_backup=True if args.report_only else args.no_backup
    )

    if args.stdout or args.report_only:
        # Print to STDOUT
        print_graph_report_stdout(root, used_files=sorted(used),
                                  unnecessary_dirs=unnecessary_dirs,
                                  keep_dirs=keep_dirs,
                                  other_unused_files=other_unused_files)
        return

    # Default: write the analytics file to disk
    write_results_file(root, used_files=sorted(used),
                       unnecessary_dirs=unnecessary_dirs,
                       keep_dirs=keep_dirs,
                       other_unused_files=other_unused_files)


    # CLI (non-GUI) mode
    compute_results(
        root, scan_dirs, allowed_exts,
        roots_cli=args.roots, include_hidden=args.include_hidden,
        dry_run=args.dry_run, no_backup=args.no_backup
    )

if __name__ == "__main__":
    main()
