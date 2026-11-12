import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { allowNavigation, allowPermission, webPreferences, windowOpenDecision, windowSize } from "../src/main/window-policy";

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

describe("windowSize", () => {
  it("uses the wanted size when the screen is big enough", () => {
    expect(windowSize({ width: 1920, height: 1040 })).toEqual({ width: 1360, height: 860, minWidth: 900, minHeight: 600 });
  });
  it("cuts the height to the usable area of a 1366x768 laptop (about 728 high with the taskbar)", () => {
    expect(windowSize({ width: 1366, height: 728 })).toEqual({ width: 1360, height: 728, minWidth: 900, minHeight: 600 });
  });
  it("cuts both sides on a small screen", () => {
    expect(windowSize({ width: 1280, height: 680 })).toEqual({ width: 1280, height: 680, minWidth: 900, minHeight: 600 });
  });
  it("never lets the minimum be bigger than the window, so a very small screen still gets a window that fits", () => {
    expect(windowSize({ width: 800, height: 500 })).toEqual({ width: 800, height: 500, minWidth: 800, minHeight: 500 });
  });
  it("takes the wanted size and minimum as arguments", () => {
    expect(windowSize({ width: 1000, height: 700 }, { width: 500, height: 400 }, { width: 300, height: 200 })).toEqual({ width: 500, height: 400, minWidth: 300, minHeight: 200 });
  });
  it("refuses sizes that are not positive whole numbers", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => windowSize({ width: bad, height: 700 }), String(bad)).toThrow(RangeError);
      expect(() => windowSize({ width: 700, height: bad }), String(bad)).toThrow(RangeError);
    }
  });
});

describe("windowSize: every size it is given is checked, not only the screen", () => {
  const OK = { width: 1000, height: 700 };
  it("refuses a wanted size that is not positive whole numbers", () => {
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => windowSize(OK, { width: bad, height: 400 }), `want.width ${bad}`).toThrow(RangeError);
      expect(() => windowSize(OK, { width: 400, height: bad }), `want.height ${bad}`).toThrow(RangeError);
    }
  });
  it("refuses a minimum that is not positive whole numbers", () => {
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => windowSize(OK, { width: 500, height: 400 }, { width: bad, height: 200 }), `min.width ${bad}`).toThrow(RangeError);
      expect(() => windowSize(OK, { width: 500, height: 400 }, { width: 300, height: bad }), `min.height ${bad}`).toThrow(RangeError);
    }
  });
  it("names which size was wrong", () => {
    expect(() => windowSize(OK, { width: 0, height: 400 })).toThrow(/want\.width/);
    expect(() => windowSize(OK, { width: 500, height: 400 }, { width: 300, height: 0 })).toThrow(/min\.height/);
    expect(() => windowSize({ width: 0, height: 700 })).toThrow(/work\.width/);
  });
});
