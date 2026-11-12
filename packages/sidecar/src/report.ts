import type { BacktestReport, ExitReason, Position } from "./types";

export class ReportError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

const UNSIGNED = /^(0|[1-9][0-9]*)$/;
const SIGNED = /^(0|-?[1-9][0-9]*)$/;
const HASH = /^[0-9a-f]{64}$/;
const REASONS: readonly ExitReason[] = ["takeProfit", "stopLoss", "maxHold", "end"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
}
function exactly(path: string, v: unknown, names: readonly string[]): Record<string, unknown> {
  if (!isRecord(v)) throw new ReportError(path, "must be an object");
  for (const k of Object.keys(v)) if (!names.includes(k)) throw new ReportError(`${path}.${k}`, "is not a field of the report");
  for (const k of names) if (!Object.hasOwn(v, k)) throw new ReportError(`${path}.${k}`, "is missing");
  return v;
}
function text(path: string, v: unknown): string {
  if (typeof v !== "string" || v === "") throw new ReportError(path, "must be non-empty text");
  return v;
}
function count(path: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new ReportError(path, "must be a whole number, 0 or more");
  return v;
}
function unsigned(path: string, v: unknown): bigint {
  if (typeof v !== "string" || !UNSIGNED.test(v)) throw new ReportError(path, "must be a whole number, 0 or more, written as text without a leading zero");
  return BigInt(v);
}
function signed(path: string, v: unknown): bigint {
  if (typeof v !== "string" || !SIGNED.test(v)) throw new ReportError(path, "must be a whole number written as text without a leading zero");
  return BigInt(v);
}

function parsePosition(p: unknown, i: number): Position {
  const w = `$.positions[${i}]`;
  const o = exactly(w, p, [
    "token", "signalTradeId", "signalWallet", "entryTradeId", "entryTime", "entryAmount", "buyFee", "cost",
    "exitTradeId", "exitTime", "exitReason", "proceeds", "sellFee", "net", "pnl",
  ]);
  const token = text(`${w}.token`, o["token"]);
  const signalTradeId = text(`${w}.signalTradeId`, o["signalTradeId"]);
  const signalWallet = text(`${w}.signalWallet`, o["signalWallet"]);
  const entryTradeId = text(`${w}.entryTradeId`, o["entryTradeId"]);
  const entryTime = count(`${w}.entryTime`, o["entryTime"]);
  const entryAmount = unsigned(`${w}.entryAmount`, o["entryAmount"]);
  const buyFee = unsigned(`${w}.buyFee`, o["buyFee"]);
  const cost = unsigned(`${w}.cost`, o["cost"]);
  const exitTradeId = text(`${w}.exitTradeId`, o["exitTradeId"]);
  const exitTime = count(`${w}.exitTime`, o["exitTime"]);
  const reason = o["exitReason"];
  if (!REASONS.includes(reason as ExitReason)) throw new ReportError(`${w}.exitReason`, `must be one of ${REASONS.join(", ")}`);
  const proceeds = unsigned(`${w}.proceeds`, o["proceeds"]);
  const sellFee = unsigned(`${w}.sellFee`, o["sellFee"]);
  const net = unsigned(`${w}.net`, o["net"]);
  const pnl = signed(`${w}.pnl`, o["pnl"]);
  if (entryAmount < 1n) throw new ReportError(`${w}.entryAmount`, "must be at least 1");
  if (exitTime < entryTime) throw new ReportError(`${w}.exitTime`, "must not be before the entry time");
  if (cost <= buyFee) throw new ReportError(`${w}.cost`, "must be more than the buy fee (the position is at least 1 unit of the quote asset)");
  if (net !== proceeds - sellFee) throw new ReportError(`${w}.net`, "must be proceeds minus the sell fee");
  if (pnl !== net - cost) throw new ReportError(`${w}.pnl`, "must be net minus cost");
  return {
    token, signalTradeId, signalWallet, entryTradeId, entryTime, entryAmount: o["entryAmount"] as string, buyFee: o["buyFee"] as string,
    cost: o["cost"] as string, exitTradeId, exitTime, exitReason: reason as ExitReason, proceeds: o["proceeds"] as string,
    sellFee: o["sellFee"] as string, net: o["net"] as string, pnl: o["pnl"] as string,
  };
}

/**
 * Strict check of the engine's report, including that its summary is the sum of its positions. The caller still has to
 * compare specHash and engineVersion with what it asked for. Returns a copy; throws ReportError naming the first wrong field.
 */
export function parseBacktestReport(input: unknown): BacktestReport {
  const top = exactly("$", input, ["engineVersion", "specHash", "dataAsOf", "positions", "summary"]);
  const engineVersion = text("$.engineVersion", top["engineVersion"]);
  const hash = top["specHash"];
  if (typeof hash !== "string" || !HASH.test(hash)) throw new ReportError("$.specHash", "must be 64 lower-case hexadecimal digits");
  const dataAsOf = top["dataAsOf"] === null ? null : count("$.dataAsOf", top["dataAsOf"]);
  if (!Array.isArray(top["positions"])) throw new ReportError("$.positions", "must be a list");
  const positions = top["positions"].map(parsePosition);

  const s = exactly("$.summary", top["summary"], [
    "signals", "ignoredWhileOpen", "skipped", "entered", "exits", "wins", "losses", "totalCost", "totalNet", "realised", "roiBps",
  ]);
  const skipped = exactly("$.summary.skipped", s["skipped"], ["noPrice", "tooSmall"]);
  const noPrice = count("$.summary.skipped.noPrice", skipped["noPrice"]);
  const tooSmall = count("$.summary.skipped.tooSmall", skipped["tooSmall"]);
  const exitsIn = exactly("$.summary.exits", s["exits"], REASONS);
  const exits = {} as Record<ExitReason, number>;
  for (const r of REASONS) exits[r] = count(`$.summary.exits.${r}`, exitsIn[r]);
  const signals = count("$.summary.signals", s["signals"]);
  const ignored = count("$.summary.ignoredWhileOpen", s["ignoredWhileOpen"]);
  const entered = count("$.summary.entered", s["entered"]);
  const wins = count("$.summary.wins", s["wins"]);
  const losses = count("$.summary.losses", s["losses"]);
  const totalCost = unsigned("$.summary.totalCost", s["totalCost"]);
  const totalNet = unsigned("$.summary.totalNet", s["totalNet"]);
  const realised = signed("$.summary.realised", s["realised"]);
  const roi = s["roiBps"];
  if (roi !== null && (typeof roi !== "number" || !Number.isSafeInteger(roi))) throw new ReportError("$.summary.roiBps", "must be a whole number or null");

  if (entered !== positions.length) throw new ReportError("$.summary.entered", "must equal the number of positions");
  if (signals !== ignored + noPrice + tooSmall + entered) throw new ReportError("$.summary.signals", "must equal ignoredWhileOpen + skipped + entered");
  for (const r of REASONS) {
    if (exits[r] !== positions.filter((p) => p.exitReason === r).length) throw new ReportError("$.summary.exits", `the count for ${r} does not match the positions`);
  }
  if (wins !== positions.filter((p) => BigInt(p.pnl) > 0n).length) throw new ReportError("$.summary.wins", "must equal the number of positions with a profit");
  if (losses !== positions.filter((p) => BigInt(p.pnl) < 0n).length) throw new ReportError("$.summary.losses", "must equal the number of positions with a loss");
  const sumCost = positions.reduce((a, p) => a + BigInt(p.cost), 0n);
  const sumNet = positions.reduce((a, p) => a + BigInt(p.net), 0n);
  if (totalCost !== sumCost) throw new ReportError("$.summary.totalCost", "must equal the sum of the position costs");
  if (totalNet !== sumNet) throw new ReportError("$.summary.totalNet", "must equal the sum of the position nets");
  if (realised !== sumNet - sumCost) throw new ReportError("$.summary.realised", "must equal totalNet minus totalCost");
  const expectedRoi = sumCost === 0n ? null : Number((realised * 10000n) / sumCost);
  if (roi !== expectedRoi) throw new ReportError("$.summary.roiBps", "must be realised * 10000 / totalCost rounded toward zero, or null when nothing was spent");

  return {
    engineVersion,
    specHash: hash,
    dataAsOf,
    positions,
    summary: {
      signals, ignoredWhileOpen: ignored, skipped: { noPrice, tooSmall }, entered, exits, wins, losses,
      totalCost: s["totalCost"] as string, totalNet: s["totalNet"] as string, realised: s["realised"] as string, roiBps: roi as number | null,
    },
  };
}
