#!/usr/bin/env python3
"""Writes the sidecar conformance vectors: packages/sidecar/vectors/{pnl,canonical,backtest}.json.

This is a THIRD, independent implementation (Python) of the rules in docs/SIDECAR-PROTOCOL.md. The TypeScript core
(packages/core) and the Go engine (private repo) must both reproduce these files exactly; neither one is the judge of
the other. Nothing here imports project code. usage: python3 scripts/sidecar-vectors/gen.py
"""
import hashlib, json, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "packages", "sidecar", "vectors")


def tdiv(a, b):
    """Division that truncates toward zero, like BigInt in JavaScript and big.Int.Quo in Go (Python's // floors)."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def byte_key(s):
    return s.encode("utf-8")


# ---------------------------------------------------------------- canonical JSON
def canonical(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        if abs(v) > 2**53 - 1:
            raise ValueError("unsafe integer")
        return str(v)
    if isinstance(v, float):
        raise ValueError("float")
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)  # escapes " \\ \b \f \n \r \t and other C0 as \u00xx; leaves the rest raw
    if isinstance(v, list):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=byte_key)
        return "{" + ",".join(canonical(k) + ":" + canonical(v[k]) for k in keys) + "}"
    raise ValueError("type")


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- FIFO PnL (same rules as packages/core/src/pnl.ts)
def pnl(trades, as_of=None, marks=None):
    seen = set()
    for t in trades:
        if not isinstance(t["id"], str) or t["id"] == "":
            raise ValueError("id")
        if t["id"] in seen:
            raise ValueError("duplicate id")
        seen.add(t["id"])
        if not t["token"]:
            raise ValueError("token")
        if t["side"] not in ("buy", "sell"):
            raise ValueError("side")
        for f, lo in (("amount", 1), ("quote", 0), ("fee", 0)):
            if f in t:
                s = t[f]
                if not (isinstance(s, str) and s.isascii() and s.isdigit() and (s == "0" or s[0] != "0")):
                    raise ValueError(f)
                if int(s) < lo:
                    raise ValueError(f)
    mk = {}
    for m in marks or []:
        if m["token"] in mk:
            raise ValueError("duplicate mark")
        if int(m["amount"]) <= 0 or int(m["quote"]) < 0:
            raise ValueError("mark")
        mk[m["token"]] = (int(m["amount"]), int(m["quote"]))
    sel = sorted([t for t in trades if as_of is None or t["time"] <= as_of], key=lambda t: (t["time"], byte_key(t["id"])))
    acc = {}
    for t in sel:
        a = acc.setdefault(t["token"], dict(bought=0, sold=0, buyCost=0, sellProceeds=0, rc=0, rp=0, um=0, up=0, lots=[], head=0))
        amount, quote, fee = int(t["amount"]), int(t["quote"]), int(t.get("fee", "0"))
        if t["side"] == "buy":
            cost = quote + fee
            a["bought"] += amount
            a["buyCost"] += cost
            a["lots"].append([amount, cost])
            continue
        net = quote - fee
        a["sold"] += amount
        a["sellProceeds"] += net
        remaining, matched, matched_cost = amount, 0, 0
        while remaining > 0 and a["head"] < len(a["lots"]):
            lot = a["lots"][a["head"]]
            take = min(remaining, lot[0])
            if take == lot[0]:
                cost = lot[1]
                a["head"] += 1
            else:
                cost = tdiv(lot[1] * take, lot[0])
                lot[0] -= take
                lot[1] -= cost
            matched_cost += cost
            matched += take
            remaining -= take
        matched_proceeds = net if matched == amount else tdiv(net * matched, amount)
        a["rc"] += matched_cost
        a["rp"] += matched_proceeds
        a["um"] += amount - matched
        a["up"] += net - matched_proceeds
    tokens, tot = [], dict(realised=0, unrealised=0, unmarkedTokens=[], unmatchedProceeds=0)
    for token in sorted(acc, key=byte_key):
        a = acc[token]
        open_amount = sum(l[0] for l in a["lots"][a["head"]:])
        open_cost = sum(l[1] for l in a["lots"][a["head"]:])
        realised = a["rp"] - a["rc"]
        if open_amount == 0:
            unreal = 0
        elif token not in mk:
            unreal = None
            tot["unmarkedTokens"].append(token)
        else:
            unreal = tdiv(open_amount * mk[token][1], mk[token][0]) - open_cost
        tokens.append(dict(token=token, boughtAmount=str(a["bought"]), soldAmount=str(a["sold"]), buyCost=str(a["buyCost"]),
                           sellProceeds=str(a["sellProceeds"]), realisedCost=str(a["rc"]), realisedProceeds=str(a["rp"]),
                           realised=str(realised), openAmount=str(open_amount), openCost=str(open_cost),
                           unmatchedSoldAmount=str(a["um"]), unmatchedProceeds=str(a["up"]),
                           unrealised=None if unreal is None else str(unreal)))
        tot["realised"] += realised
        tot["unmatchedProceeds"] += a["up"]
        if unreal is not None:
            tot["unrealised"] += unreal
    return dict(tokens=tokens, totals=dict(realised=str(tot["realised"]), unrealised=str(tot["unrealised"]),
                                           unmarkedTokens=tot["unmarkedTokens"], unmatchedProceeds=str(tot["unmatchedProceeds"])))


def T(id, time, token, side, amount, quote, fee=None, wallet=None):
    t = dict(id=id, time=time, token=token, side=side, amount=str(amount), quote=str(quote))
    if fee is not None:
        t["fee"] = str(fee)
    if wallet is not None:
        t["wallet"] = wallet
    return t


def pnl_cases():
    cases = []

    def ok(name, trades, as_of=None, marks=None):
        params = dict(trades=trades)
        if as_of is not None:
            params["asOf"] = as_of
        if marks is not None:
            params["marks"] = marks
        cases.append(dict(name=name, params=params, expected=pnl(trades, as_of, marks)))

    def bad(name, trades, as_of=None, marks=None):
        params = dict(trades=trades)
        if as_of is not None:
            params["asOf"] = as_of
        if marks is not None:
            params["marks"] = marks
        try:
            pnl(trades, as_of, marks)
        except ValueError:
            cases.append(dict(name=name, params=params, expectError=True))
            return
        raise SystemExit("case %r was expected to be invalid" % name)

    ok("empty", [])
    ok("one round trip: realised = proceeds - cost", [T("b1", 10, "X", "buy", 1000, 1000000), T("s1", 20, "X", "sell", 1000, 2000000)])
    ok("partial sells floor the matched cost and nothing is lost", [
        T("b1", 10, "X", "buy", 3, 10), T("s1", 20, "X", "sell", 1, 5), T("s2", 30, "X", "sell", 1, 5), T("s3", 40, "X", "sell", 1, 5)])
    ok("fees add to cost on a buy and come off proceeds on a sell", [
        T("b1", 10, "X", "buy", 1000, 1000, fee=50), T("s1", 20, "X", "sell", 1000, 2000, fee=100)])
    ok("a sell with no known buy is unmatched and never counted as profit", [T("s1", 10, "X", "sell", 10, 100)])
    ok("a sell larger than the buys splits its proceeds pro rata", [T("b1", 10, "X", "buy", 4, 40), T("s1", 20, "X", "sell", 10, 100)])
    ok("negative net proceeds divide toward zero, not toward minus infinity", [
        T("b1", 10, "X", "buy", 2, 20), T("s1", 20, "X", "sell", 3, 5, fee=10)])
    ok("asOf cuts the history, trades after it are not read", [
        T("b1", 1, "X", "buy", 10, 100), T("s1", 2, "X", "sell", 10, 150), T("b2", 3, "X", "buy", 10, 100)], as_of=2)
    ok("asOf equal to a trade's time includes that trade", [T("b1", 5, "X", "buy", 10, 100), T("s1", 5, "X", "sell", 10, 150)], as_of=5)
    ok("same time: ties are broken by id, so input order does not matter (sell first = unmatched)", [
        T("b", 100, "X", "buy", 10, 100), T("a", 100, "X", "sell", 10, 150)])
    ok("same time: buy id sorts first, so it matches", [
        T("a", 100, "X", "buy", 10, 100), T("b", 100, "X", "sell", 10, 150)])
    ok("marks value what is still held", [T("b1", 10, "X", "buy", 500, 500000)], marks=[dict(token="X", amount="1000", quote="500000")])
    ok("a token held with no mark is null and listed as unmarked", [T("b1", 10, "X", "buy", 5, 50), T("b2", 11, "Y", "buy", 5, 50)],
       marks=[dict(token="Y", amount="1", quote="20")])
    ok("a fully closed token needs no mark, and a mark for an unknown token is ignored", [
        T("b1", 10, "X", "buy", 5, 50), T("s1", 11, "X", "sell", 5, 60)], marks=[dict(token="X", amount="1", quote="1"), dict(token="Z", amount="1", quote="1")])
    ok("a zero-quote buy (a transfer in) costs nothing", [T("b1", 10, "X", "buy", 10, 0), T("s1", 11, "X", "sell", 10, 70)])
    ok("amounts beyond 64 bits stay exact", [
        T("b1", 1, "X", "buy", 10**30, 10**28 + 7), T("s1", 2, "X", "sell", 10**30 // 3, 5 * 10**27 + 11)])
    ok("tokens come back sorted by address", [T("b1", 1, "b", "buy", 1, 1), T("b2", 2, "a", "buy", 1, 1), T("b3", 3, "B", "buy", 1, 1)])
    ok("every trade is after asOf: nothing to report", [T("b1", 10, "X", "buy", 1, 1)], as_of=5)
    bad("amount zero", [T("b1", 10, "X", "buy", 0, 5)])
    bad("duplicate trade id", [T("b1", 10, "X", "buy", 1, 5), T("b1", 11, "X", "sell", 1, 5)])
    bad("side must be buy or sell", [dict(id="b1", time=1, token="X", side="swap", amount="1", quote="1")])
    bad("an invalid trade after asOf is still rejected", [T("b1", 1, "X", "buy", 1, 1), T("b2", 99, "X", "buy", 0, 1)], as_of=5)
    bad("empty id", [T("", 1, "X", "buy", 1, 1)])
    bad("fee must be a whole number written in digits", [T("b1", 1, "X", "buy", 1, 1, fee="1.5")])
    bad("amount must not have a leading zero", [T("b1", 1, "X", "buy", "01", 1)])
    bad("mark amount zero", [T("b1", 1, "X", "buy", 1, 1)], marks=[dict(token="X", amount="0", quote="1")])
    bad("two marks for one token", [T("b1", 1, "X", "buy", 1, 1)], marks=[dict(token="X", amount="1", quote="1"), dict(token="X", amount="2", quote="2")])
    return cases


# ---------------------------------------------------------------- backtest reference (docs/SIDECAR-PROTOCOL.md, "backtest.run")
def backtest(spec, trades):
    s, c = spec["strategy"], spec["costs"]
    frm, to = spec["from"], spec["to"]
    watch = set(s["wallets"])
    P, fee_bps, slip = int(s["positionQuote"]), c["feeBps"], c["slippageBps"]
    tp, sl, hold, lat = s["takeProfitBps"], s["stopLossBps"], s["maxHoldMs"], s["latencyMs"]
    seen = set()
    for t in trades:
        if t["id"] in seen or int(t["amount"]) <= 0 or int(t["quote"]) < 0 or t["side"] not in ("buy", "sell"):
            raise ValueError("bad trade")
        seen.add(t["id"])
    rows = sorted([t for t in trades if frm <= t["time"] <= to], key=lambda t: (t["time"], byte_key(t["id"])))
    by_token = {}
    for t in rows:
        by_token.setdefault(t["token"], []).append(t)
    positions = []
    signals = ignored = no_price = too_small = 0
    for token in sorted(by_token, key=byte_key):
        ser = by_token[token]
        blocked = -1
        for i, sg in enumerate(ser):
            if not (sg["wallet"] in watch and sg["side"] == "buy" and int(sg["quote"]) > 0):
                continue
            signals += 1
            if i <= blocked:
                ignored += 1
                continue
            j = next((k for k in range(i + 1, len(ser)) if ser[k]["time"] >= sg["time"] + lat and int(ser[k]["quote"]) > 0), None)
            if j is None:
                no_price += 1
                continue
            aj, qj = int(ser[j]["amount"]), int(ser[j]["quote"])
            tokens = (P * aj * 10000) // (qj * (10000 + slip))
            if tokens == 0:
                too_small += 1
                continue
            buy_fee = P * fee_bps // 10000
            cost = P + buy_fee
            exit_k = reason = None
            for k in range(j + 1, len(ser)):
                q = int(ser[k]["quote"])
                if q == 0:
                    continue
                a = int(ser[k]["amount"])
                if sl is not None and q * aj * 10000 <= qj * a * (10000 - sl):
                    exit_k, reason = k, "stopLoss"
                    break
                if tp is not None and q * aj * 10000 >= qj * a * (10000 + tp):
                    exit_k, reason = k, "takeProfit"
                    break
                if ser[k]["time"] - ser[j]["time"] >= hold:
                    exit_k, reason = k, "maxHold"
                    break
            if exit_k is None:
                exit_k = next(k for k in range(len(ser) - 1, j - 1, -1) if int(ser[k]["quote"]) > 0)
                reason = "end"
            qk, ak = int(ser[exit_k]["quote"]), int(ser[exit_k]["amount"])
            gross = tokens * qk * (10000 - slip) // (ak * 10000)
            sell_fee = gross * fee_bps // 10000
            net = gross - sell_fee
            positions.append(dict(token=token, signalTradeId=sg["id"], signalWallet=sg["wallet"], entryTradeId=ser[j]["id"],
                                  entryTime=ser[j]["time"], entryAmount=str(tokens), buyFee=str(buy_fee), cost=str(cost),
                                  exitTradeId=ser[exit_k]["id"], exitTime=ser[exit_k]["time"], exitReason=reason,
                                  proceeds=str(gross), sellFee=str(sell_fee), net=str(net), pnl=str(net - cost)))
            blocked = exit_k
    positions.sort(key=lambda p: (p["entryTime"], byte_key(p["entryTradeId"])))
    total_cost = sum(int(p["cost"]) for p in positions)
    total_net = sum(int(p["net"]) for p in positions)
    realised = total_net - total_cost
    summary = dict(signals=signals, ignoredWhileOpen=ignored, skipped=dict(noPrice=no_price, tooSmall=too_small),
                   entered=len(positions),
                   exits={r: sum(1 for p in positions if p["exitReason"] == r) for r in ("takeProfit", "stopLoss", "maxHold", "end")},
                   wins=sum(1 for p in positions if int(p["pnl"]) > 0), losses=sum(1 for p in positions if int(p["pnl"]) < 0),
                   totalCost=str(total_cost), totalNet=str(total_net), realised=str(realised),
                   roiBps=None if total_cost == 0 else tdiv(realised * 10000, total_cost))
    return dict(specHash=sha(canonical(spec)), dataAsOf=max((t["time"] for t in rows), default=None), positions=positions, summary=summary)


def spec(wallets=("alice",), frm=0, to=10_000_000, latency=0, quote=1_000_000, tp=None, sl=None, hold=1_000_000, fee=0, slip=0):
    return dict(version=1, **{"from": frm, "to": to}, strategy=dict(kind="follow-wallets", wallets=list(wallets), latencyMs=latency,
                positionQuote=str(quote), takeProfitBps=tp, stopLossBps=sl, maxHoldMs=hold), costs=dict(feeBps=fee, slippageBps=slip))


def backtest_cases():
    cases = []

    def case(name, sp, trades, note=None):
        d = dict(name=name, spec=sp, trades=trades, expected=backtest(sp, trades))
        if note:
            d["note"] = note
        cases.append(d)

    base = lambda q3, extra=(): [T("t1", 1000, "X", "buy", 1000, 1_000_000, wallet="alice"), T("t2", 2000, "X", "buy", 1000, 1_000_000, wallet="bob"),
                                 T("t3", 3000, "X", "sell", 1000, q3, wallet="carol"), *extra]
    case("take profit at exactly +50%", spec(tp=5000, sl=2000), base(1_500_000),
         "alice buys at t1 (price 1000); we enter at t2 (price 1000): 1000 units for 1,000,000. t3 is price 1500 = +5000 bps, so we sell 1000 units for 1,500,000: pnl +500,000, roi +5000 bps.")
    case("one unit under the take-profit line does not exit (it ends at the last price instead)", spec(tp=5000, sl=2000), base(1_499_999))
    case("stop loss at exactly -20%", spec(tp=5000, sl=2000), base(800_000),
         "t3 is price 800 = -2000 bps: stop loss. Sold for 800,000: pnl -200,000, roi -2000 bps.")
    case("max hold: first priced trade at or after entry time + 5000", spec(hold=5000), base(1_100_000, [T("t4", 7000, "X", "sell", 1000, 1_200_000, wallet="carol")]))
    case("max hold skips a zero-quote trade (a transfer has no price)", spec(hold=5000), [
        T("t1", 1000, "X", "buy", 1000, 1_000_000, wallet="alice"), T("t2", 2000, "X", "buy", 1000, 1_000_000, wallet="bob"),
        T("t3", 8000, "X", "sell", 1000, 0, wallet="carol"), T("t4", 9000, "X", "sell", 1000, 1_300_000, wallet="carol")])
    case("end of window: closed at the last priced trade, a later trade is never read", spec(to=5000, tp=5000), base(900_000, [T("t4", 6000, "X", "sell", 1000, 5_000_000, wallet="carol")]),
         "t4 (price 5000) is after 'to' and would have triggered the take profit. It must not be read: the position ends at t3 (price 900).")
    case("latency: the entry is the first priced trade at or after signal time + latency", spec(latency=1500), [
        T("t1", 1000, "X", "buy", 1000, 1_000_000, wallet="alice"), T("t2", 1200, "X", "buy", 1000, 1_100_000, wallet="bob"),
        T("t3", 2500, "X", "buy", 1000, 1_200_000, wallet="bob"), T("t4", 4000, "X", "sell", 1000, 1_500_000, wallet="bob")])
    case("signals while a position is open are ignored; the next one after the exit enters again", spec(tp=1000), [
        T("a1", 1000, "X", "buy", 1000, 1_000_000, wallet="alice"), T("a2", 1100, "X", "buy", 1000, 1_000_000, wallet="bob"),
        T("a3", 1200, "X", "buy", 1000, 1_000_000, wallet="alice"), T("a4", 1300, "X", "buy", 1000, 1_100_000, wallet="bob"),
        T("a5", 1400, "X", "buy", 1000, 1_000_000, wallet="alice"), T("a6", 1500, "X", "buy", 1000, 1_000_000, wallet="bob"),
        T("a7", 1600, "X", "sell", 1000, 1_200_000, wallet="bob")])
    case("a watched zero-quote buy is not a signal, and zero-quote trades are not entry prices", spec(), [
        T("t1", 1000, "X", "buy", 1000, 0, wallet="alice"), T("t2", 1500, "X", "buy", 1000, 1_000_000, wallet="alice"),
        T("t3", 1600, "X", "buy", 1000, 0, wallet="bob"), T("t4", 1700, "X", "buy", 1000, 1_000_000, wallet="bob")])
    case("no priced trade after the signal: skipped (noPrice)", spec(), [T("t1", 1000, "X", "buy", 1000, 1_000_000, wallet="alice")])
    case("fees and slippage use floor division everywhere", spec(quote=1_234_567, fee=100, slip=50, tp=2000, hold=10_000), [
        T("t1", 1000, "X", "buy", 3, 5, wallet="alice"), T("t2", 2000, "X", "buy", 7, 13, wallet="bob"), T("t3", 3000, "X", "sell", 11, 31, wallet="bob")])
    case("the window starts at 'from': a signal before it is not used", spec(frm=2000, to=6000), [
        T("t1", 1500, "X", "buy", 1000, 1_000_000, wallet="alice"), T("t2", 2500, "X", "buy", 1000, 1_000_000, wallet="bob"),
        T("t3", 3000, "X", "buy", 1000, 1_000_000, wallet="alice"), T("t4", 4000, "X", "sell", 1000, 1_100_000, wallet="bob")])
    case("several tokens and wallets: unwatched buys and watched sells are not signals; positions sort by entry time then id", spec(wallets=("alice", "carol")), [
        T("p1", 1000, "B", "buy", 100, 100_000, wallet="alice"), T("p2", 1000, "A", "buy", 100, 100_000, wallet="carol"),
        T("p3", 1100, "B", "buy", 100, 100_000, wallet="bob"), T("p4", 1100, "A", "buy", 100, 100_000, wallet="bob"),
        T("p5", 1200, "A", "sell", 100, 100_000, wallet="alice"), T("p6", 1300, "B", "sell", 100, 150_000, wallet="dave"),
        T("p7", 1400, "A", "buy", 100, 100_000, wallet="dave")])
    case("same time: only a trade after the signal in (time, id) order can be the entry", spec(), [
        T("s0", 1000, "X", "buy", 1000, 2_000_000, wallet="bob"), T("s1", 1000, "X", "buy", 1000, 1_000_000, wallet="alice"),
        T("s2", 1000, "X", "buy", 1000, 1_500_000, wallet="bob"), T("s3", 1001, "X", "sell", 1000, 1_700_000, wallet="bob")])
    case("a position too small to buy a single unit is skipped (tooSmall)", spec(quote=5), [
        T("t1", 1000, "X", "buy", 1, 1_000_000, wallet="alice"), T("t2", 2000, "X", "buy", 1, 1_000_000, wallet="bob")])
    case("stop loss wins over max hold when the same trade meets both", spec(sl=1000, hold=1000), [
        T("t1", 1000, "X", "buy", 1000, 1_000_000, wallet="alice"), T("t2", 1500, "X", "buy", 1000, 1_000_000, wallet="bob"),
        T("t3", 5000, "X", "sell", 1000, 800_000, wallet="bob")])
    case("no signals at all", spec(wallets=("zed",)), [T("t1", 1000, "X", "buy", 1000, 1_000_000, wallet="alice")])
    case("no trades at all", spec(), [])
    case("positions that win, lose and break even are counted separately", spec(wallets=("alice",), hold=500), [
        T("a", 1000, "X", "buy", 10, 10_000, wallet="alice"), T("b", 1100, "X", "buy", 10, 10_000, wallet="bob"), T("c", 1700, "X", "sell", 10, 20_000, wallet="bob"),
        T("d", 2000, "Y", "buy", 10, 10_000, wallet="alice"), T("e", 2100, "Y", "buy", 10, 10_000, wallet="bob"), T("f", 2700, "Y", "sell", 10, 5_000, wallet="bob"),
        T("g", 3000, "Z", "buy", 10, 10_000, wallet="alice"), T("h", 3100, "Z", "buy", 10, 10_000, wallet="bob"), T("i", 3700, "Z", "sell", 10, 10_000, wallet="bob")],
         "the three exits are at 2.0x, 0.5x and 1.0x the entry price: one win, one loss, one break-even (neither).")
    return cases


def invalid_specs():
    good = spec()
    out = []

    def bad(name, mutate):
        sp = json.loads(json.dumps(good))
        mutate(sp)
        out.append(dict(name=name, spec=sp))

    def setp(path, value):
        def f(sp):
            node = sp
            for k in path[:-1]:
                node = node[k]
            node[path[-1]] = value
        return f

    def drop(path):
        def f(sp):
            node = sp
            for k in path[:-1]:
                node = node[k]
            del node[path[-1]]
        return f

    for name, path in [("version", ["version"]), ("from", ["from"]), ("to", ["to"]), ("strategy", ["strategy"]), ("costs", ["costs"]),
                       ("kind", ["strategy", "kind"]), ("wallets", ["strategy", "wallets"]), ("latencyMs", ["strategy", "latencyMs"]),
                       ("positionQuote", ["strategy", "positionQuote"]), ("takeProfitBps", ["strategy", "takeProfitBps"]),
                       ("stopLossBps", ["strategy", "stopLossBps"]), ("maxHoldMs", ["strategy", "maxHoldMs"]),
                       ("feeBps", ["costs", "feeBps"]), ("slippageBps", ["costs", "slippageBps"])]:
        bad("missing " + name, drop(path))
    bad("unknown top-level field", setp(["extra"], 1))
    bad("unknown strategy field", setp(["strategy", "extra"], 1))
    bad("unknown costs field", setp(["costs", "extra"], 1))
    bad("version 2", setp(["version"], 2))
    bad("version as text", setp(["version"], "1"))
    bad("from fractional", setp(["from"], 1.5))
    bad("from negative", setp(["from"], -1))
    bad("from after to", setp(["from"], 10_000_001))
    bad("window longer than 5 years", setp(["to"], 5 * 366 * 86_400_000 + 1))
    bad("another strategy kind", setp(["strategy", "kind"], "random"))
    bad("no wallets", setp(["strategy", "wallets"], []))
    bad("101 wallets", setp(["strategy", "wallets"], ["w%d" % i for i in range(101)]))
    bad("duplicate wallets", setp(["strategy", "wallets"], ["a", "a"]))
    bad("empty wallet", setp(["strategy", "wallets"], [""]))
    bad("wallet with a space", setp(["strategy", "wallets"], ["a b"]))
    bad("wallet not ASCII", setp(["strategy", "wallets"], ["\u00e9"]))
    bad("wallet 129 characters", setp(["strategy", "wallets"], ["x" * 129]))
    bad("wallet not text", setp(["strategy", "wallets"], [5]))
    bad("latency negative", setp(["strategy", "latencyMs"], -1))
    bad("latency over a day", setp(["strategy", "latencyMs"], 86_400_001))
    for v in ("0", "01", "-5", "1.5", "", 5):
        bad("positionQuote %r" % (v,), setp(["strategy", "positionQuote"], v))
    bad("positionQuote 40 digits", setp(["strategy", "positionQuote"], "1" * 40))
    for v in (0, 1_000_001, 1.5, "5"):
        bad("takeProfitBps %r" % (v,), setp(["strategy", "takeProfitBps"], v))
    for v in (0, 10_000, -1, 1.5):
        bad("stopLossBps %r" % (v,), setp(["strategy", "stopLossBps"], v))
    for v in (0, None, 2_592_000_001):
        bad("maxHoldMs %r" % (v,), setp(["strategy", "maxHoldMs"], v))
    for v in (-1, 1001, 1.5):
        bad("feeBps %r" % (v,), setp(["costs", "feeBps"], v))
    for v in (-1, 5001):
        bad("slippageBps %r" % (v,), setp(["costs", "slippageBps"], v))
    return out


def canonical_cases():
    values = [
        ("keys are sorted", {"b": 1, "a": 2}),
        ("nested objects and arrays keep array order", {"z": [3, 1, 2], "a": {"y": None, "x": True}, "m": False}),
        ("empty containers", {"a": [], "b": {}}),
        ("integers", [0, -5, 9007199254740991, -9007199254740991]),
        ("string escapes", "quote \" backslash \\ newline \n tab \t cr \r bs \b ff \f"),
        ("other control characters use \\u00xx in lower case", "\u0001\u001f\u007f"),
        ("characters that JSON could escape stay raw", "<>&\u2028\u2029 \u00e9 \u4e2d \U0001F600"),
        ("keys sort by UTF-8 bytes, not UTF-16 units (U+FF5E before U+10000)", {"\U00010000": 1, "\uff5e": 2, "a": 3}),
        ("keys with escapes", {"a\"b": 1, "a\nb": 2}),
        ("a realistic spec", spec(wallets=("w1", "w2"), tp=5000, sl=2000)),
    ]
    cases = [dict(name=n, value=v, canonical=canonical(v), sha256=sha(canonical(v))) for n, v in values]
    invalid = [
        ("a fractional number", 1.5), ("a fractional number inside an array", [1, 2.5]), ("a fractional number inside an object", {"a": 0.25}),
        ("an integer beyond 2^53-1", 9007199254740993), ("a negative integer beyond -(2^53-1)", -9007199254740993),
    ]
    return dict(cases=cases, invalid=[dict(name=n, value=v) for n, v in invalid])


def write(name, data):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=1, ensure_ascii=True)
        f.write("\n")
    return path


if __name__ == "__main__":
    p = pnl_cases()
    b = backtest_cases()
    c = canonical_cases()
    inv = invalid_specs()
    write("pnl.json", dict(note="Generated by scripts/sidecar-vectors/gen.py (independent Python implementation). Do not edit by hand.", cases=p))
    write("backtest.json", dict(note="Generated by scripts/sidecar-vectors/gen.py. 'expected' lacks engineVersion, which varies. Do not edit by hand.", cases=b, invalidSpecs=inv))
    write("canonical.json", dict(note="Generated by scripts/sidecar-vectors/gen.py. Do not edit by hand.", **c))
    print("pnl cases:", len(p), "(errors:", sum(1 for x in p if x.get("expectError")), ")  backtest cases:", len(b), " invalid specs:", len(inv), " canonical:", len(c["cases"]), "+", len(c["invalid"]), "invalid")
