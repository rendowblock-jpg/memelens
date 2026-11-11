#!/usr/bin/env python3
"""Mutation runner for the desktop smoke test. Never touches the real tree: works on a scratch copy of apps/desktop.

usage: smoke-mutate.py MUTATIONS.json
MUTATIONS.json: [{"name": "...", "file": "src/main/app.ts", "old": "...", "new": "...", "expect": "caught"|"survive"}]
`file` is relative to apps/desktop. A mutant is CAUGHT if scripts/smoke-desktop.sh fails on the mutated copy.
"expect": "survive" marks a mutant the smoke test cannot see from inside the page (the unit tests cover it); the run
only fails on a surprise in either direction.
"""
import json, os, shutil, subprocess, sys

root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
muts = json.load(open(sys.argv[1]))
base = os.path.expanduser("~/.cache/memelens-smoke-mut")
scratch = os.path.join(base, "run")
shutil.rmtree(scratch, ignore_errors=True)
os.makedirs(os.path.join(scratch, "apps"))
shutil.copytree(
    os.path.join(root, "apps", "desktop"),
    os.path.join(scratch, "apps", "desktop"),
    ignore=shutil.ignore_patterns("dist", "node_modules", "test"),
)
# esbuild and the workspace packages are found through this link; the packages are not mutated.
os.symlink(os.path.join(root, "node_modules"), os.path.join(scratch, "node_modules"))
app = os.path.join(scratch, "apps", "desktop")
env = dict(os.environ, SMOKE_DIR=os.path.join(base, "db"))


def smoke():
    r = subprocess.run([os.path.join(root, "scripts", "smoke-desktop.sh"), app], capture_output=True, text=True, env=env, timeout=90)
    return r.returncode, r.stdout + r.stderr


try:
    code, out = smoke()
    if code != 0:
        print("BASELINE RED: the smoke test fails without any mutation, so no result below would mean anything.")
        print("\n".join(out.splitlines()[-15:]))
        sys.exit(3)
    print("baseline green", flush=True)
    surprises = invalid = 0
    for m in muts:
        path = os.path.join(app, m["file"])
        original = open(path).read()
        n = original.count(m["old"])
        if n != 1:
            print(f"INVALID  {m['name']}: pattern matched {n} times (need exactly 1)", flush=True)
            invalid += 1
            continue
        open(path, "w").write(original.replace(m["old"], m["new"], 1))
        try:
            code, out = smoke()
        finally:
            open(path, "w").write(original)
        caught = code != 0
        expect = m.get("expect", "caught")
        verdict = "caught  " if caught else "SURVIVED"
        note = ""
        if caught != (expect == "caught"):
            note = "  <-- SURPRISE (expected " + expect + ")"
            surprises += 1
        elif expect == "survive":
            note = "  (expected: not visible from the page; covered by unit tests)"
        failing = [l for l in out.splitlines() if l.startswith("FAIL") or l.startswith("SMOKE ERROR") or "TIMEOUT" in l]
        print(f"{verdict} {m['name']}{note}", flush=True)
        if caught:
            print(f"           exit {code}; {failing[0][:100] if failing else 'no FAIL line'}", flush=True)
    print(f"-- {len(muts)} mutants: {surprises} surprises, {invalid} invalid", flush=True)
    sys.exit(1 if (surprises or invalid) else 0)
finally:
    shutil.rmtree(scratch, ignore_errors=True)
