// Reports its own environment so a test can see what the app passed on.
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "hello") return send({ id, result: { protocol: 1, engineVersion: "9.9.9", capabilities: [] } });
  if (method === "env") return send({ id, result: process.env });
  if (method === "shutdown") {
    send({ id, result: null });
    return void setTimeout(() => process.exit(0), 10);
  }
  send({ id, error: { code: -32601, message: "method not found" } });
});
