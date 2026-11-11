import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ORIGIN, CSP, isAppUrl, resolveAppFile } from "../src/main/security";

const ROOT = resolve("/srv/memelens/dist/renderer");

describe("isAppUrl", () => {
  it("accepts the app origin, with or without a path, query or fragment", () => {
    expect(APP_ORIGIN).toBe("app://memelens");
    for (const u of ["app://memelens", "app://memelens/", "app://memelens/index.html", "app://memelens/a/b.js?x=1#top"]) {
      expect(isAppUrl(u), u).toBe(true);
    }
  });

  it("refuses every other origin, including look-alikes", () => {
    const bad = [
      "",
      "memelens",
      "app://memelens.evil.com/",
      "app://evilmemelens/",
      "app://xmemelens/x",
      "app://:pw@memelens/",
      "app://evil/",
      "app://memelens@evil/",
      "app://evil@memelens/",
      "app://user:pw@memelens/",
      "app://memelens:80/",
      "app:memelens",
      "app:/memelens/",
      "file:///etc/passwd",
      "file:///C:/memelens/index.html",
      "https://memelens/",
      "http://memelens/",
      "javascript:alert(1)",
      "data:text/html,hi",
      "about:blank",
      "//memelens/",
    ];
    for (const u of bad) expect(isAppUrl(u), JSON.stringify(u)).toBe(false);
  });

  it("is case-insensitive about scheme and host, as URLs are", () => {
    expect(isAppUrl("APP://MEMELENS/index.html")).toBe(true);
  });
});

describe("resolveAppFile", () => {
  it("maps paths to files under the root, and / to index.html", () => {
    expect(resolveAppFile(ROOT, "app://memelens/")).toBe(join(ROOT, "index.html"));
    expect(resolveAppFile(ROOT, "app://memelens")).toBe(join(ROOT, "index.html"));
    expect(resolveAppFile(ROOT, "app://memelens/index.html")).toBe(join(ROOT, "index.html"));
    expect(resolveAppFile(ROOT, "app://memelens/assets/app-1a2b.js")).toBe(join(ROOT, "assets", "app-1a2b.js"));
  });

  it("ignores the query string and the fragment", () => {
    expect(resolveAppFile(ROOT, "app://memelens/assets/a.js?v=2#x")).toBe(join(ROOT, "assets", "a.js"));
    expect(resolveAppFile(ROOT, "app://memelens/?x=1")).toBe(join(ROOT, "index.html"));
  });

  it("decodes percent-escapes in ordinary names", () => {
    expect(resolveAppFile(ROOT, "app://memelens/a%20b.txt")).toBe(join(ROOT, "a b.txt"));
  });

  it("refuses another scheme or host", () => {
    for (const u of ["http://memelens/index.html", "file:///srv/memelens/dist/renderer/index.html", "app://evil/index.html", "app://memelens.evil/x", "app://memelens:81/x", "app://u@memelens/x", "app://:pw@memelens/x", "app://evilmemelens/x"]) {
      expect(resolveAppFile(ROOT, u), u).toBeNull();
    }
  });

  it("refuses text that is not a URL", () => {
    for (const u of ["", "not a url", "/etc/passwd", "../x"]) expect(resolveAppFile(ROOT, u), JSON.stringify(u)).toBeNull();
  });

  it("never leaves the root, however the dots are written", () => {
    // The URL parser itself removes plain and %2e dot segments, so these stay inside the root:
    expect(resolveAppFile(ROOT, "app://memelens/../secret")).toBe(join(ROOT, "secret"));
    expect(resolveAppFile(ROOT, "app://memelens/%2e%2e/secret")).toBe(join(ROOT, "secret"));
    expect(resolveAppFile(ROOT, "app://memelens/a/../../secret")).toBe(join(ROOT, "secret"));
    // An encoded slash is not a segment break to the parser, so a ".." can appear only after decoding. Refuse it.
    for (const u of [
      "app://memelens/..%2fsecret",
      "app://memelens/%2e%2e%2fsecret",
      "app://memelens/a%2f..%2f..%2fsecret",
      "app://memelens/a/..%2f..%2fsecret",
      "app://memelens/..%2F",
      "app://memelens/%2e%2e%5csecret",
      "app://memelens/a%2f.%2fb",
    ]) {
      expect(resolveAppFile(ROOT, u), u).toBeNull();
    }
  });

  it("refuses backslashes, drive letters, stream names, NUL and malformed escapes", () => {
    for (const u of [
      "app://memelens/a%5cb",
      "app://memelens/a%5c..%5csecret",
      "app://memelens/C:/Windows/win.ini",
      "app://memelens/C%3a/Windows",
      "app://memelens/index.html:stream",
      "app://memelens/a%00b",
      "app://memelens/a%01b",
      "app://memelens/a%09b",
      "app://memelens/a%0ab",
      "app://memelens/a%1fb",
      "app://memelens/a%7fb",
      "app://memelens/%zz",
      "app://memelens/%e0%a4%a",
    ]) {
      expect(resolveAppFile(ROOT, u), u).toBeNull();
    }
  });

  it("refuses a doubled slash that would make an empty segment", () => {
    expect(resolveAppFile(ROOT, "app://memelens//etc/passwd")).toBeNull();
    expect(resolveAppFile(ROOT, "app://memelens/a//b")).toBeNull();
  });

  it("returns a path that really is inside the root for every accepted input", () => {
    const inputs = ["app://memelens/", "app://memelens/x", "app://memelens/../x", "app://memelens/a/b/c.css", "app://memelens/%2e%2e/%2e%2e/x"];
    for (const u of inputs) {
      const f = resolveAppFile(ROOT, u)!;
      expect(f.startsWith(ROOT + sep), u).toBe(true);
    }
  });
});

describe("CSP", () => {
  const directives = (): Record<string, string> =>
    Object.fromEntries(
      CSP.split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const [name, ...rest] = d.split(/\s+/);
          return [name!, rest.join(" ")];
        }),
    );

  it("denies everything by default and allows only the app's own scripts and styles", () => {
    const d = directives();
    expect(d["default-src"]).toBe("'none'");
    expect(d["script-src"]).toBe("'self'");
    expect(d["style-src"]).toBe("'self'");
    expect(d["img-src"]).toBe("'self' data:");
    expect(d["font-src"]).toBe("'self'");
  });

  it("allows no network, no frames, no forms, no plugins and no base tag", () => {
    const d = directives();
    expect(d["connect-src"]).toBe("'none'");
    expect(d["frame-src"]).toBe("'none'");
    expect(d["frame-ancestors"]).toBe("'none'");
    expect(d["form-action"]).toBe("'none'");
    expect(d["object-src"]).toBe("'none'");
    expect(d["base-uri"]).toBe("'none'");
  });

  it("allows no inline or eval code", () => {
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:/);
  });
});

describe("values that are not strings", () => {
  // The types say string, but the values come from a browser process. `new URL(x)` turns any object into a string
  // with its toString(), so an object that prints as a trusted URL would be accepted unless the type is checked.
  const lookAlike = { toString: () => "app://memelens/index.html" };
  const notStrings: unknown[] = [lookAlike, new URL("app://memelens/index.html"), ["app://memelens/index.html"], 42, null, undefined, {}];

  it("isAppUrl refuses them", () => {
    for (const v of notStrings) expect(isAppUrl(v as string), String(v)).toBe(false);
  });

  it("resolveAppFile refuses them", () => {
    for (const v of notStrings) expect(resolveAppFile(ROOT, v as string), String(v)).toBeNull();
  });
});
