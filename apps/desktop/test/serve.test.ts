import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planResponse } from "../src/main/serve";
import { CSP } from "../src/main/security";

const ROOT = resolve("/srv/memelens/dist/renderer");
const everything = () => true;

function ok(plan: ReturnType<typeof planResponse>) {
  if (plan.status !== 200) throw new Error(`expected 200, got ${plan.status}`);
  return plan;
}

describe("planResponse: what is served", () => {
  it("serves index.html for the bare origin, with the security headers", () => {
    const plan = ok(planResponse(ROOT, "GET", "app://memelens/", everything));
    expect(plan.file).toBe(join(ROOT, "index.html"));
    expect(plan.headers).toEqual({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("serves nested files and ignores the query string and fragment", () => {
    const plan = ok(planResponse(ROOT, "GET", "app://memelens/assets/app.js?v=3#x", everything));
    expect(plan.file).toBe(join(ROOT, "assets", "app.js"));
  });

  it("answers HEAD like GET", () => {
    expect(planResponse(ROOT, "HEAD", "app://memelens/", everything).status).toBe(200);
  });

  it("gives each known file type its content type", () => {
    const types: Record<string, string> = {
      "a.html": "text/html; charset=utf-8",
      "a.js": "text/javascript; charset=utf-8",
      "a.mjs": "text/javascript; charset=utf-8",
      "a.css": "text/css; charset=utf-8",
      "a.json": "application/json; charset=utf-8",
      "a.svg": "image/svg+xml",
      "a.png": "image/png",
      "a.ico": "image/x-icon",
      "a.woff2": "font/woff2",
    };
    for (const [name, type] of Object.entries(types)) {
      const plan = ok(planResponse(ROOT, "GET", `app://memelens/${name}`, everything));
      expect(plan.headers["Content-Type"], name).toBe(type);
    }
  });

  it("matches the file extension without regard to case", () => {
    const plan = ok(planResponse(ROOT, "GET", "app://memelens/INDEX.HTML", everything));
    expect(plan.headers["Content-Type"]).toBe("text/html; charset=utf-8");
  });

  it("asks isFile about exactly the resolved path, once", () => {
    const asked: string[] = [];
    planResponse(ROOT, "GET", "app://memelens/assets/app.js", (p) => (asked.push(p), true));
    expect(asked).toEqual([join(ROOT, "assets", "app.js")]);
  });
});

describe("planResponse: what is refused", () => {
  it("refuses methods other than GET and HEAD with 405", () => {
    for (const m of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "", "GET ", "CONNECT"]) {
      expect(planResponse(ROOT, m, "app://memelens/", everything).status, JSON.stringify(m)).toBe(405);
    }
  });

  it("checks the method before anything else", () => {
    expect(planResponse(ROOT, "POST", "https://evil.example/", () => false).status).toBe(405);
  });

  it("refuses other origins and path escapes with 403", () => {
    const bad = [
      "https://evil.example/index.html",
      "file:///etc/passwd",
      "app://evil/index.html",
      "app://memelens/%2e%2e%2fsecret.js",
      "app://memelens/a%5c..%5cb.js",
      "app://memelens/C:/x.js",
      "app://memelens/assets/",
      "not a url",
    ];
    for (const u of bad) expect(planResponse(ROOT, "GET", u, everything).status, u).toBe(403);
  });

  it("refuses file types the app never ships with 403, whether or not the file exists", () => {
    let asked = 0;
    for (const name of ["a.exe", "a.sqlite", "a.txt", "a.map", "noextension", "a.js.exe", ".js"]) {
      const plan = planResponse(ROOT, "GET", `app://memelens/${name}`, () => (asked++, true));
      expect(plan.status, name).toBe(403);
    }
    // The file system was never asked, so a refusal reveals nothing about what exists.
    expect(asked).toBe(0);
  });

  it("answers 404 for a known file type that does not exist", () => {
    expect(planResponse(ROOT, "GET", "app://memelens/missing.js", () => false).status).toBe(404);
  });

  it("answers 404 for a missing index.html", () => {
    expect(planResponse(ROOT, "GET", "app://memelens/", () => false).status).toBe(404);
  });

  it("has no headers or file on a refusal", () => {
    expect(planResponse(ROOT, "GET", "app://memelens/missing.js", () => false)).toEqual({ status: 404 });
    expect(planResponse(ROOT, "POST", "app://memelens/", everything)).toEqual({ status: 405 });
    expect(planResponse(ROOT, "GET", "app://evil/", everything)).toEqual({ status: 403 });
  });
});
