import { run } from "./cli";

// Thin process wrapper: all behaviour lives in run(), which is tested without spawning anything.
process.exitCode = await run(process.argv.slice(2), {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
});
