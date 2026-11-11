import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { allowNavigation, allowPermission, webPreferences, windowOpenDecision } from "../src/main/window-policy";

const PRELOAD = resolve("/srv/memelens/dist/preload.cjs");

describe("webPreferences", () => {
  it("turns on every isolation switch and turns off every Node switch", () => {
    const p = webPreferences(PRELOAD, false);
    expect(p).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false,
      spellcheck: false,
    });
  });

  it("sets the preload script and nothing that loosens the policy", () => {
    const p = webPreferences(PRELOAD, false);
    expect(p["preload"]).toBe(PRELOAD);
    // Every value is a plain boolean or the preload path: no hidden extras such as enableRemoteModule.
    for (const [k, v] of Object.entries(p)) {
      if (k !== "preload") expect(typeof v, k).toBe("boolean");
    }
  });

  it("passes the developer tools switch through, and defaults to nothing else", () => {
    expect(webPreferences(PRELOAD, false)["devTools"]).toBe(false);
    expect(webPreferences(PRELOAD, true)["devTools"]).toBe(true);
  });

  it("refuses a relative or empty preload path", () => {
    for (const bad of ["", "preload.cjs", "./preload.cjs", "../preload.cjs"]) {
      expect(() => webPreferences(bad, false), JSON.stringify(bad)).toThrow(/absolute/);
    }
  });
});

describe("navigation and permissions", () => {
  it("lets the window stay on the app origin only", () => {
    expect(allowNavigation("app://memelens/index.html")).toBe(true);
    for (const u of ["https://example.com/", "file:///C:/x.html", "app://evil/", "about:blank", "javascript:alert(1)", ""]) {
      expect(allowNavigation(u), u).toBe(false);
    }
  });

  it("denies every new window", () => {
    expect(windowOpenDecision()).toEqual({ action: "deny" });
  });

  it("denies every permission", () => {
    expect(allowPermission()).toBe(false);
  });
});
