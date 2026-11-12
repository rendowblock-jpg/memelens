import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkForUpdate, installUpdate, SidecarClient, trustedSidecarKeys, type CheckResult, type UpdateConfig } from "@memelens/sidecar";
import { describe, expect, it } from "vitest";
import { ENGINE_RELEASE } from "../src/main/engine-release";

// The published engine, fetched from the real release host with the real trust anchor, installed, started and used.
// Skipped unless MEMELENS_LIVE_VERSION names the version that was just published: the publish workflow of the private engine
// repository sets it on Windows and Linux after it pushes, and nothing else runs this, so ordinary CI never needs the network.
const EXPECTED = process.env["MEMELENS_LIVE_VERSION"];
const live = EXPECTED === undefined ? describe.skip : describe;

// How long to wait for a release pushed a moment ago to become visible. The override exists to see this test fail quickly.
const WAIT_MS = Number(process.env["MEMELENS_LIVE_WAIT_MS"] ?? 9 * 60_000);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const describeResult = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : JSON.stringify(e));

live("the engine published for this app", () => {
  it(
    "is found, verified against the pinned key, installed, started, used for a backtest, and then reported up to date",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "memelens-live-"));
      try {
        const config: UpdateConfig = { root, baseUrl: ENGINE_RELEASE.baseUrl, allowedHosts: ENGINE_RELEASE.allowedHosts, publicKeys: trustedSidecarKeys() };

        // raw.githubusercontent.com keeps an answer for a few minutes (a 404 too), so a release pushed a moment ago may take a
        // while to show: wait for the version that was published, and say what was seen if it never comes.
        const deadline = Date.now() + WAIT_MS;
        let seen = "nothing yet";
        let found: Extract<CheckResult, { kind: "available" }> | undefined;
        while (found === undefined) {
          try {
            const r = await checkForUpdate(config);
            seen = r.kind === "available" ? `version ${r.offer.manifest.engineVersion}` : r.kind;
            if (r.kind === "available" && r.offer.manifest.engineVersion === EXPECTED) found = r;
          } catch (e) {
            seen = describeResult(e);
          }
          if (found === undefined) {
            if (Date.now() > deadline) throw new Error(`version ${EXPECTED} was not visible after ${Math.round(WAIT_MS / 1000)} s; the last answer was: ${seen}`);
            await sleep(Math.min(15_000, Math.max(1, deadline - Date.now())));
          }
        }

        const info = await installUpdate(config, found.offer); // downloads, checks size and SHA-256, starts it for its self-test, activates
        expect(info.version).toBe(EXPECTED);
        expect(info.engineVersion).toBe(EXPECTED);

        // And it does real work: the first backtest vector, answered by the very binary that was downloaded.
        const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/sidecar/vectors/backtest.json", import.meta.url)), "utf8"));
        const c = await SidecarClient.start({ command: info.binary, helloTimeoutMs: 30_000 });
        try {
          const v = vectors.cases[0];
          const { engineVersion, ...report } = await c.backtest(v.spec, { source: "inline", trades: v.trades });
          expect(engineVersion).toBe(EXPECTED);
          expect(report).toEqual(v.expected);
        } finally {
          await c.close();
        }

        expect(await checkForUpdate(config)).toEqual({ kind: "up-to-date", version: EXPECTED });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    12 * 60_000,
  );
});
