// Bundles the four pieces of the desktop app into dist/. Run: node build.mjs
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "renderer"), { recursive: true });

const common = { bundle: true, logLevel: "warning", target: "es2022", legalComments: "none" };
const node = { ...common, platform: "node", format: "cjs", external: ["electron"] };

await build({ ...node, entryPoints: [join(here, "src/main/main.ts")], outfile: join(dist, "main.cjs") });
await build({ ...node, entryPoints: [join(here, "src/main/smoke.ts")], outfile: join(dist, "smoke.cjs") });
await build({ ...node, entryPoints: [join(here, "src/main/shots.ts")], outfile: join(dist, "shots.cjs") });
await build({ ...node, entryPoints: [join(here, "src/preload/preload.ts")], outfile: join(dist, "preload.cjs") });
await build({
  ...common,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  entryPoints: [join(here, "src/renderer/main.tsx")],
  outfile: join(dist, "renderer/main.js"),
});
for (const f of ["index.html", "style.css"]) cpSync(join(here, "src/renderer", f), join(dist, "renderer", f));
console.log("built", dist);
