import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { launch } from "./app";

// Takes pictures of the real app (the real window, the real database) for looking at. A separate entry point,
// bundled to dist/shots.cjs, so nothing here sits in the shipped main.cjs. Output: SHOTS_DIR/NN-name.png.

const DIR = process.env["SHOTS_DIR"] ?? "";
const STEPS: readonly { name: string; width: number; height: number; script: string }[] = JSON.parse(process.env["SHOTS_STEPS"] ?? "[]");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function run(): Promise<number> {
  const dbPath = process.env["MEMELENS_DB"];
  if (!dbPath || !DIR) throw new Error("MEMELENS_DB and SHOTS_DIR are required");
  mkdirSync(DIR, { recursive: true });
  const { window } = await launch({
    dbPath,
    rendererRoot: join(__dirname, "renderer"),
    preloadPath: join(__dirname, "preload.cjs"),
    devTools: false,
    log: (line) => console.error(`[app] ${line}`),
  });
  const contents = window.webContents;
  const waitFor = async (script: string, what: string): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if ((await contents.executeJavaScript(`Boolean(${script})`)) === true) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  await waitFor("document.body.dataset.state", "the first screen");
  let n = 0;
  for (const step of STEPS) {
    window.setContentSize(step.width, step.height);
    // A step script returns a selector to wait for after it has acted (or "" to just wait a moment).
    const wait = (await contents.executeJavaScript(step.script)) as string;
    if (wait) await waitFor(`document.querySelector(${JSON.stringify(wait)})`, wait);
    await sleep(350);
    const image = await contents.capturePage();
    n += 1;
    const file = join(DIR, `${String(n).padStart(2, "0")}-${step.name}.png`);
    writeFileSync(file, image.toPNG());
    console.log(`SHOT ${file} ${image.getSize().width}x${image.getSize().height}`);
  }
  return 0;
}

const timer = setTimeout(() => {
  console.error("SHOTS TIMEOUT after 90 s");
  app.exit(2);
}, 90_000);
run()
  .then((code) => app.exit(code))
  .catch((e: unknown) => {
    console.error("SHOTS ERROR:", e);
    app.exit(3);
  })
  .finally(() => clearTimeout(timer));
