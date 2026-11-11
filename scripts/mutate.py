#!/usr/bin/env python3
"""Tiny mutation runner. Never touches the real tree: works on a scratch copy.

usage: mutate.py MUTATIONS.json TEST_FILE [TEST_FILE ...]
MUTATIONS.json: [{"name": "...", "file": "packages/data/src/store.ts", "old": "...", "new": "..."}]
Each mutation must match exactly once. A mutant is CAUGHT if the tests fail, SURVIVED if they pass.
"""
import json, os, shutil, subprocess, sys, tempfile

root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
muts = json.load(open(sys.argv[1]))
tests = sys.argv[2:]
scratch = tempfile.mkdtemp(prefix="memelens-mut-")
try:
    shutil.copytree(root, scratch, symlinks=True, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".git"))
    # A mutant only counts as "caught" if the tests were green without it. Check that first.
    base = subprocess.run(["npx", "vitest", "run", *tests], cwd=scratch, capture_output=True, text=True, timeout=120)
    if base.returncode != 0:
        print("BASELINE RED: the tests fail without any mutation, so no result below would mean anything.")
        print("\n".join(base.stdout.splitlines()[-15:]))
        sys.exit(3)
    caught = survived = invalid = 0
    for m in muts:
        path = os.path.join(scratch, m["file"])
        original = open(path).read()
        n = original.count(m["old"])
        if n != 1:
            print(f"INVALID  {m['name']}: pattern matched {n} times (need exactly 1)")
            invalid += 1
            continue
        open(path, "w").write(original.replace(m["old"], m["new"], 1))
        r = subprocess.run(["npx", "vitest", "run", *tests], cwd=scratch, capture_output=True, text=True, timeout=120)
        open(path, "w").write(original)
        if r.returncode == 0:
            print(f"SURVIVED {m['name']}")
            survived += 1
        else:
            print(f"caught   {m['name']}")
            caught += 1
    print(f"-- {len(muts)} mutants: {caught} caught, {survived} survived, {invalid} invalid")
    sys.exit(1 if (survived or invalid) else 0)
finally:
    shutil.rmtree(scratch, ignore_errors=True)
