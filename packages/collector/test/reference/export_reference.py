#!/usr/bin/env python3
"""A second, independent implementation of the holder-snapshot rules in docs/DESIGN.md ("Calibration collection", scoring
input). It shares no code with packages/collector/src/export.ts; the numbers it prints are pasted into
packages/collector/test/export.test.ts as the expected values, so a mistake would have to be made twice, in two languages.

usage: python3 export_reference.py FIXTURE.json [PROTOCOL_WALLET ...]
"""
import json, sys

# pump.fun mints 1,000,000,000 tokens and sells 793,100,000 on the curve; the other 206,900,000 stay in the curve's
# account until it graduates. Measured on 13 Nov 2026: where the curve is listed as a holder, its listed balance equals
# the market's vault balance plus this reserve, exactly, on 6 of 6 reports.
RESERVE_TOKENS = 206_900_000


def snapshot(report, protocol_wallets=()):
    supply = int(report["token"]["supply"])
    decimals = int(report["token"]["decimals"])
    holders = report["topHolders"]
    markets = report.get("markets") or []
    market_owners = {m["pubkey"] for m in markets}
    known_non_holders = {k for k, v in (report.get("knownAccounts") or {}).items() if v["type"] in ("AMM", "LOCKER")}
    excluded = market_owners | known_non_holders | set(protocol_wallets)

    by_owner = {}
    for h in holders:
        by_owner[h["owner"]] = by_owner.get(h["owner"], 0) + int(h["amount"])
    listed_total = sum(by_owner.values())

    # Every market whose owner is NOT among the listed holders holds tokens that no holder row shows: add them up.
    curve_listed = any(m["pubkey"] in by_owner for m in markets)
    curve_unlisted = 0
    unmodelled = False
    for m in markets:
        if m["pubkey"] in by_owner:
            continue
        side = [m.get(k) for k in ("liquidityAAccount", "liquidityBAccount") if (m.get(k) or {}).get("mint") == report["mint"]]
        if not side or m.get("marketType") not in ("pump_fun", "pump_fun_amm"):
            unmodelled = True
            continue
        vault = int(side[0]["amount"])
        curve_unlisted += vault + (RESERVE_TOKENS * 10**decimals if m["marketType"] == "pump_fun" else 0)

    remainder = supply - listed_total - curve_unlisted
    tail_holders = max(0, int(report["totalHolders"]) - len(holders))
    tolerance = supply // 1000  # 0.1% of supply

    if unmodelled:
        quality = "unmodelled"
    elif remainder < -tolerance:
        quality = "inconsistent"
    elif tail_holders > 0:
        quality = "estimated"
    elif remainder > tolerance:
        quality = "unattributed"
    else:
        quality = "exact"

    counted = {o: a for o, a in by_owner.items() if o not in excluded}
    tail = []
    if tail_holders > 0 and remainder > 0:
        each, extra = divmod(remainder, tail_holders)
        tail = [each + (extra if i == 0 else 0) for i in range(tail_holders)]
    amounts = sorted(list(counted.values()) + tail, reverse=True)
    total = sum(amounts)

    def share(n):
        return sum(amounts[:n]) / total if total else None

    hhi = sum((a / total) ** 2 for a in amounts) if total else None

    creator = report["creator"]
    if creator in excluded:
        creator_share = None  # the creator is a market, a locker or a protocol wallet: no share can be named
    elif creator in by_owner:
        creator_share = by_owner[creator] / total if total else None
    elif tail_holders == 0 and quality in ("exact", "unattributed"):
        creator_share = 0.0  # every holder is listed and the creator is not one of them
    else:
        creator_share = None  # the creator may be one of the unlisted holders: not known

    return {
        "quality": quality,
        "supply": supply,
        "listed": len(holders),
        "tailHolders": tail_holders,
        "curveListed": curve_listed,
        "curveUnlisted": curve_unlisted,
        "remainder": remainder,
        "countedHolders": len(amounts),
        "countedTotal": total,
        "top10Share": share(10),
        "top1Share": share(1),
        "hhi": hhi,
        "creatorShare": creator_share,
        "mintAuthorityActive": report["mintAuthority"] is not None,
        "freezeAuthorityActive": report["freezeAuthority"] is not None,
    }


def largest_counted_owner(report):
    """The listed owner with the most tokens that is not a market, a known AMM or a locker (ties: the smaller address)."""
    excluded = {m["pubkey"] for m in (report.get("markets") or [])} | {k for k, v in (report.get("knownAccounts") or {}).items() if v["type"] in ("AMM", "LOCKER")}
    by_owner = {}
    for h in report["topHolders"]:
        if h["owner"] not in excluded:
            by_owner[h["owner"]] = by_owner.get(h["owner"], 0) + int(h["amount"])
    if not by_owner:
        return None
    return sorted(by_owner.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]


def protocol_wallets(reports, threshold=0.25):
    """Owners that are the largest counted holder in at least `threshold` of ALL the reports given."""
    counts = {}
    for r in reports:
        o = largest_counted_owner(r)
        if o is not None:
            counts[o] = counts.get(o, 0) + 1
    return sorted(o for o, n in counts.items() if n >= threshold * len(reports))


if __name__ == "__main__":
    # usage: export_reference.py FIXTURE.json [WALLET ...]     one report
    #        export_reference.py --all DIR                    every rugcheck-*.json in DIR: census, then each report with and without it
    if sys.argv[1] == "--all":
        import glob, os
        files = sorted(glob.glob(os.path.join(sys.argv[2], "rugcheck-young-*.json"))) + [os.path.join(sys.argv[2], "rugcheck-report-established.json")]
        reports = [json.load(open(f)) for f in files]
        wallets = protocol_wallets(reports)
        out = {"protocolWallets": wallets, "reports": {}}
        for f, r in zip(files, reports):
            out["reports"][os.path.basename(f)] = {"withoutProtocolWallets": snapshot(r, []), "withProtocolWallets": snapshot(r, wallets)}
        print(json.dumps(out, indent=1, sort_keys=True))
    else:
        report = json.load(open(sys.argv[1]))
        print(json.dumps(snapshot(report, sys.argv[2:]), indent=1))
