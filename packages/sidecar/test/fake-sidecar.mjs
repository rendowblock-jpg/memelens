// A stand-in for the engine that speaks the line protocol. FAKE_MODE and the request method pick the behaviour.
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MODE ?? "ok";
const protocol = mode === "old-protocol" ? 2 : 1;
const capabilities = mode.startsWith("bt") ? ["backtest.run", "pnl.compute"] : ["echo"];
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");

if (mode === "stderr") process.stderr.write("engine says hello\n");
if (mode === "spam") for (let i = 0; i < 30; i++) process.stdout.write("not json\n");
if (mode === "bigline") process.stdout.write("x".repeat(5000) + "\n");

let runId = null;
const rl = createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0)); // the engine exits when stdin closes
rl.on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "hello") {
    if (mode === "silent-hello") return;
    return send({ id, result: { protocol, engineVersion: "9.9.9", capabilities } });
  }
  switch (method) {
    case "echo":
      return send({ id, result: params });
    case "boom":
      return send({ id, error: { code: -32602, message: "bad things", data: { why: "test" } } });
    case "never":
      return;
    case "delay":
      return void setTimeout(() => send({ id, result: { tag: params.tag } }), params.ms);
    case "progress":
      send({ method: "backtest.progress", params: { id, done: 1, total: 2 } });
      send({ method: "backtest.progress", params: { id, done: 2, total: 2 } });
      return send({ id, result: "done" });
    case "die":
      return process.exit(3);
    case "garbage-then-answer":
      process.stdout.write("this is not json\n");
      return send({ id, result: "ok" });
    case "unknown-id":
      send({ id: 99999, result: "stray" });
      return send({ id, result: "ok" });
    case "backtest.run":
      if (mode === "bt-echo") return send({ id, error: { code: -32602, message: "echo", data: params } });
      if (mode === "bt-cancel") {
        runId = id;
        send({ method: "backtest.progress", params: { id, done: 0, total: 10 } });
        return; // runs until cancelled
      }
      send({ method: "backtest.progress", params: { id, done: 1, total: 2 } });
      send({ method: "backtest.progress", params: { id: 424242, done: 7, total: 7 } }); // someone else's progress
      send({ method: "backtest.progress", params: { id, done: 2, total: 2 } });
      return send({ id, result: JSON.parse(process.env.FAKE_REPORT ?? "null") });
    case "backtest.cancel":
      send({ id, result: { cancelled: true } });
      return send({ id: runId, error: { code: -32001, message: "cancelled", data: { runId, cancelId: params.id } } });
    case "shutdown":
      if (mode === "hung") return;
      send({ id, result: null });
      return void setTimeout(() => process.exit(0), 10);
    default:
      return send({ id, error: { code: -32601, message: "method not found" } });
  }
});
