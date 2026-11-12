import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activate, binaryName, currentPlatform, installPointer, isValidVersion, LayoutError, listInstalled, readPointer, resolveCurrent, resolveSidecarRoot, rollback, SIDECAR_DIR_ENV, sidecarRoot, verifyInstalled,
  type PointerOps, type Platform,
} from "../src/layout";

describe("sidecarRoot", () => {
  it("is %LOCALAPPDATA%\\MemeLens\\sidecar on Windows, independent of the app's name, version and install path", () => {
    expect(sidecarRoot("win32", { LOCALAPPDATA: "C:\\Users\\DMR\\AppData\\Local" }, "C:\\Users\\DMR")).toBe("C:\\Users\\DMR\\AppData\\Local\\MemeLens\\sidecar");
  });
  it("refuses a missing or relative LOCALAPPDATA instead of guessing a place", () => {
    expect(() => sidecarRoot("win32", {}, "C:\\Users\\DMR")).toThrow(LayoutError);
    expect(() => sidecarRoot("win32", { LOCALAPPDATA: "AppData\\Local" }, "C:\\Users\\DMR")).toThrow(LayoutError);
    expect(() => sidecarRoot("win32", { LOCALAPPDATA: "" }, "C:\\Users\\DMR")).toThrow(LayoutError);
  });
  it("is ~/Library/Application Support/MemeLens/sidecar on macOS", () => {
    expect(sidecarRoot("darwin", {}, "/Users/d")).toBe("/Users/d/Library/Application Support/MemeLens/sidecar");
  });
  it("follows XDG_DATA_HOME on Linux when it is an absolute path, and otherwise ~/.local/share", () => {
    expect(sidecarRoot("linux", { XDG_DATA_HOME: "/data" }, "/home/d")).toBe("/data/memelens/sidecar");
    expect(sidecarRoot("linux", {}, "/home/d")).toBe("/home/d/.local/share/memelens/sidecar");
    expect(sidecarRoot("linux", { XDG_DATA_HOME: "relative/dir" }, "/home/d")).toBe("/home/d/.local/share/memelens/sidecar");
    expect(sidecarRoot("linux", { XDG_DATA_HOME: "" }, "/home/d")).toBe("/home/d/.local/share/memelens/sidecar");
  });
  it("refuses a platform it does not know, and a relative home", () => {
    expect(() => sidecarRoot("freebsd" as Platform, {}, "/home/d")).toThrow(LayoutError);
    expect(() => sidecarRoot("linux", {}, "home/d")).toThrow(LayoutError);
  });
  it("names the binary memelens-sidecar.exe on Windows only", () => {
    expect(binaryName("win32")).toBe("memelens-sidecar.exe");
    expect(binaryName("linux")).toBe("memelens-sidecar");
    expect(binaryName("darwin")).toBe("memelens-sidecar");
    expect(["win32", "darwin", "linux"]).toContain(currentPlatform());
  });
});

describe("isValidVersion", () => {
  it("accepts plain semantic versions and pre-releases", () => {
    for (const v of ["0.1.0", "1.2.3", "10.20.30", "1.2.3-rc.1", "1.2.3-alpha", "1.2.3-0.3.7", "1.2.3-x-y.z"]) expect(isValidVersion(v), v).toBe(true);
  });
  it("refuses anything that could name another folder or is not a clean version", () => {
    const bad = ["", "1.2", "v1.2.3", "1.2.3+build", "../1.2.3", "1.2.3/..", "1.2.3\\x", " 1.2.3", "1.2.3 ", "1.2.3\n", "01.2.3", "1.02.3", "1.2.03", "1.2.3-", "1.2.3-.", "1.2.3-a..b", "1.2.3-a b", "..", ".", "1.2.3.4", "1.2.3-é", "a".repeat(65), 123, null, undefined, {}];
    for (const v of bad) expect(isValidVersion(v), JSON.stringify(v)).toBe(false);
    expect(isValidVersion("1.2.3-" + "a".repeat(58))).toBe(true);
    expect(isValidVersion("1.2.3-" + "a".repeat(59))).toBe(false);
  });
});

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "memelens-layout-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const NAME = binaryName(currentPlatform());

/** Writes versions/<version>/ with a binary and a manifest that describe each other. */
function install(root: string, version: string, content = `engine ${version}`, manifest: Record<string, unknown> = {}): string {
  const dir = join(root, "versions", version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, NAME), content);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifestVersion: 1, engineVersion: version, protocol: 1, file: NAME, size: Buffer.byteLength(content), sha256: sha(content), ...manifest }));
  return dir;
}

describe("pointers (current.json / previous.json)", () => {
  it("reads nothing when the file does not exist", () => {
    expect(readPointer(tmp(), "current")).toBeNull();
  });
  it("writes a pointer and reads it back", () => {
    const root = tmp();
    installPointer(root, "current", "1.2.3");
    expect(readPointer(root, "current")).toEqual({ version: "1.2.3" });
    expect(JSON.parse(readFileSync(join(root, "current.json"), "utf8"))).toEqual({ version: "1.2.3" });
    expect(readdirSync(root).sort()).toEqual(["current.json"]); // no temp file left behind
  });
  it("creates the folder when it is not there yet", () => {
    const root = join(tmp(), "a", "b");
    installPointer(root, "previous", "0.1.0");
    expect(readPointer(root, "previous")).toEqual({ version: "0.1.0" });
  });
  it("refuses to write an invalid version, and to read a pointer that holds one (a path-traversal guard)", () => {
    const root = tmp();
    expect(() => installPointer(root, "current", "../../etc")).toThrow(LayoutError);
    writeFileSync(join(root, "current.json"), '{"version":"../../etc"}');
    expect(() => readPointer(root, "current")).toThrow(LayoutError);
  });
  it("refuses a pointer that is not exactly {version}", () => {
    const root = tmp();
    for (const text of ["", "not json", "[]", "null", '{"version":5}', '{"version":"1.2.3","extra":1}', "{}"]) {
      writeFileSync(join(root, "current.json"), text);
      expect(() => readPointer(root, "current"), text).toThrow(LayoutError);
    }
  });
  it("replaces the pointer in one step: a failure in the middle leaves the old pointer and no stray file", () => {
    const root = tmp();
    installPointer(root, "current", "1.0.0");
    const failing: PointerOps = {
      writeFileSync: (p, d) => writeFileSync(p, d),
      renameSync: () => {
        throw new Error("disk went away");
      },
      rmSync: (p, o) => rmSync(p, o),
    };
    expect(() => installPointer(root, "current", "2.0.0", failing)).toThrow(/disk went away/);
    expect(readPointer(root, "current")).toEqual({ version: "1.0.0" });
    expect(readdirSync(root).sort()).toEqual(["current.json"]);
  });
});

describe("verifyInstalled", () => {
  it("accepts a version whose binary matches its manifest and returns where it is", () => {
    const root = tmp();
    install(root, "1.2.3");
    expect(verifyInstalled(root, "1.2.3")).toEqual({ version: "1.2.3", engineVersion: "1.2.3", protocol: 1, binary: join(root, "versions", "1.2.3", NAME) });
  });
  it("refuses a version that is not installed, or not a valid version", () => {
    const root = tmp();
    expect(() => verifyInstalled(root, "1.2.3")).toThrow(/not installed/);
    expect(() => verifyInstalled(root, "../x")).toThrow(LayoutError);
  });
  it("refuses a binary that was changed after the manifest was written (hash), or cut short (size)", () => {
    const root = tmp();
    const dir = install(root, "1.2.3", "engine one");
    writeFileSync(join(dir, NAME), "engine two"); // same length, different bytes
    expect(() => verifyInstalled(root, "1.2.3")).toThrow(/sha256|hash/i);
    writeFileSync(join(dir, NAME), "engine");
    expect(() => verifyInstalled(root, "1.2.3")).toThrow(/size/i);
  });
  it("refuses a missing binary, a missing manifest and a malformed one", () => {
    const root = tmp();
    const dir = install(root, "1.2.3");
    rmSync(join(dir, NAME));
    expect(() => verifyInstalled(root, "1.2.3")).toThrow(LayoutError);
    const root2 = tmp();
    const dir2 = install(root2, "1.2.3");
    rmSync(join(dir2, "manifest.json"));
    expect(() => verifyInstalled(root2, "1.2.3")).toThrow(/manifest/);
    for (const text of ["", "nope", "[]", '{"manifestVersion":1}']) {
      writeFileSync(join(dir2, "manifest.json"), text);
      expect(() => verifyInstalled(root2, "1.2.3"), text).toThrow(/manifest/);
    }
  });
  it("refuses a manifest that belongs to another version, another file name or an unknown manifest version", () => {
    const root = tmp();
    install(root, "1.2.3", "x", { engineVersion: "9.9.9" });
    expect(() => verifyInstalled(root, "1.2.3")).toThrow(/engineVersion|version/);
    const root2 = tmp();
    install(root2, "1.2.3", "x", { file: "other.exe" });
    expect(() => verifyInstalled(root2, "1.2.3")).toThrow(/file/);
    const root3 = tmp();
    install(root3, "1.2.3", "x", { manifestVersion: 2 });
    expect(() => verifyInstalled(root3, "1.2.3")).toThrow(/manifestVersion/);
    const root4 = tmp();
    install(root4, "1.2.3", "x", { file: "../../evil" });
    expect(() => verifyInstalled(root4, "1.2.3")).toThrow(LayoutError);
  });
});

describe("activate, rollback, resolveCurrent", () => {
  it("activates the first version: current is set, previous stays empty", () => {
    const root = tmp();
    install(root, "1.0.0");
    activate(root, "1.0.0");
    expect(readPointer(root, "current")).toEqual({ version: "1.0.0" });
    expect(readPointer(root, "previous")).toBeNull();
  });
  it("keeps the version it replaces as previous", () => {
    const root = tmp();
    install(root, "1.0.0");
    install(root, "2.0.0");
    activate(root, "1.0.0");
    activate(root, "2.0.0");
    expect(readPointer(root, "current")).toEqual({ version: "2.0.0" });
    expect(readPointer(root, "previous")).toEqual({ version: "1.0.0" });
  });
  it("does not turn previous into the same version when it is activated again", () => {
    const root = tmp();
    install(root, "1.0.0");
    install(root, "2.0.0");
    activate(root, "1.0.0");
    activate(root, "2.0.0");
    activate(root, "2.0.0");
    expect(readPointer(root, "previous")).toEqual({ version: "1.0.0" });
  });
  it("refuses to activate what is not installed or does not verify, and changes nothing", () => {
    const root = tmp();
    install(root, "1.0.0");
    activate(root, "1.0.0");
    expect(() => activate(root, "2.0.0")).toThrow(/not installed/);
    const dir = install(root, "3.0.0", "good");
    writeFileSync(join(dir, NAME), "evil");
    expect(() => activate(root, "3.0.0")).toThrow(LayoutError);
    expect(readPointer(root, "current")).toEqual({ version: "1.0.0" });
    expect(readPointer(root, "previous")).toBeNull();
  });
  it("rolls back: current and previous swap, and the new current is returned", () => {
    const root = tmp();
    install(root, "1.0.0");
    install(root, "2.0.0");
    activate(root, "1.0.0");
    activate(root, "2.0.0");
    expect(rollback(root)).toBe("1.0.0");
    expect(readPointer(root, "current")).toEqual({ version: "1.0.0" });
    expect(readPointer(root, "previous")).toEqual({ version: "2.0.0" });
  });
  it("cannot roll back with nothing to go back to, or to a version that no longer verifies", () => {
    const root = tmp();
    install(root, "1.0.0");
    activate(root, "1.0.0");
    expect(() => rollback(root)).toThrow(/previous/);
    install(root, "2.0.0");
    activate(root, "2.0.0");
    writeFileSync(join(root, "versions", "1.0.0", NAME), "tampered!!!");
    expect(() => rollback(root)).toThrow(LayoutError);
    expect(readPointer(root, "current")).toEqual({ version: "2.0.0" });
  });
  it("resolves the current version and checks it again every time (a binary replaced by an attacker is caught at launch)", () => {
    const root = tmp();
    expect(resolveCurrent(root)).toBeNull();
    const dir = install(root, "1.0.0");
    activate(root, "1.0.0");
    expect(resolveCurrent(root)).toMatchObject({ version: "1.0.0", binary: join(dir, NAME) });
    writeFileSync(join(dir, NAME), "engine 9.9.9"); // same size as "engine 1.0.0"
    expect(() => resolveCurrent(root)).toThrow(LayoutError);
  });
  it("lists installed versions that are valid folders, ignoring junk", () => {
    const root = tmp();
    install(root, "1.0.0");
    install(root, "2.0.0");
    install(root, "1.10.0");
    mkdirSync(join(root, "versions", "tmp"), { recursive: true });
    mkdirSync(join(root, "versions", "1.2"), { recursive: true });
    writeFileSync(join(root, "versions", "9.9.9"), "a file, not a folder");
    expect(listInstalled(root)).toEqual(["1.0.0", "1.10.0", "2.0.0"]);
    expect(listInstalled(tmp())).toEqual([]);
    expect(existsSync(root)).toBe(true);
  });
});

import { compareVersions } from "../src/layout";
import { symlinkSync } from "node:fs";

describe("compareVersions (semantic-version precedence)", () => {
  it("compares numbers by value, not as text", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
    expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
    expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
  });
  it("puts a release after its own pre-releases", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
  });
  it("orders pre-release identifiers: numbers by value and before text, text by letters, shorter list first", () => {
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) expect(compareVersions(order[i]!, order[j]!), `${order[i]} vs ${order[j]}`).toBe(Math.sign(i - j));
  });
  it("refuses what is not a version", () => {
    expect(() => compareVersions("1.2", "1.2.3")).toThrow(LayoutError);
    expect(() => compareVersions("1.2.3", "../x")).toThrow(LayoutError);
  });
});

describe("version rules that came from the semantic-version standard", () => {
  it("does not accept a numeric pre-release identifier with a leading zero", () => {
    expect(isValidVersion("1.2.3-01")).toBe(false);
    expect(isValidVersion("1.2.3-rc.01")).toBe(false);
    expect(isValidVersion("1.2.3-0")).toBe(true);
    expect(isValidVersion("1.2.3-0a")).toBe(true);
    expect(isValidVersion("1.2.3-1a2")).toBe(true);
  });
});

describe("a damaged pointer does not block installing a good version", () => {
  it("activates over an unreadable current.json, and rolls back over one", () => {
    const root = tmp();
    install(root, "1.0.0");
    install(root, "2.0.0");
    writeFileSync(join(root, "current.json"), "garbage");
    activate(root, "1.0.0");
    expect(readPointer(root, "current")).toEqual({ version: "1.0.0" });
    expect(readPointer(root, "previous")).toBeNull();
    activate(root, "2.0.0");
    writeFileSync(join(root, "current.json"), "garbage");
    expect(rollback(root)).toBe("1.0.0");
    expect(readPointer(root, "current")).toEqual({ version: "1.0.0" });
    // current.json was unreadable, so there was nothing to put into previous.json: it keeps what it had (1.0.0)
    expect(readPointer(root, "previous")).toEqual({ version: "1.0.0" });
  });
  it("reads a pointer error that is not 'file missing' as an error", () => {
    const root = tmp();
    mkdirSync(join(root, "current.json")); // a folder where the file should be
    expect(() => readPointer(root, "current")).toThrow(LayoutError);
  });
});

describe.skipIf(process.platform === "win32")("a symlink is not accepted as the binary", () => {
  it("refuses it, even if it points at a file with the right content", () => {
    const root = tmp();
    const dir = install(root, "1.0.0", "engine 1.0.0");
    const real = join(root, "real-binary");
    writeFileSync(real, "engine 1.0.0");
    rmSync(join(dir, NAME));
    symlinkSync(real, join(dir, NAME));
    expect(() => verifyInstalled(root, "1.0.0")).toThrow(/regular file/);
  });
});

describe("more layout rules", () => {
  it("refuses a relative home folder on macOS as well as on Linux", () => {
    expect(() => sidecarRoot("darwin", {}, "Users/d")).toThrow(LayoutError);
    expect(() => sidecarRoot("darwin", {}, "")).toThrow(LayoutError);
  });
  it("does not let a version name reach outside versions/ by way of '..' (it must be refused before any folder is looked at)", () => {
    const root = tmp();
    const dir = join(root, "evil"); // reachable as versions/../evil
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, NAME), "engine");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifestVersion: 1, engineVersion: "../evil", protocol: 1, file: NAME, size: 6, sha256: sha("engine") }));
    expect(() => verifyInstalled(root, "../evil")).toThrow(/not a valid version/);
  });
  it("refuses a manifest protocol below 1 or not whole", () => {
    for (const protocol of [0, -1, 1.5, "1", null]) {
      const root = tmp();
      install(root, "1.0.0", "x", { protocol });
      expect(() => verifyInstalled(root, "1.0.0"), String(protocol)).toThrow(/protocol/);
    }
  });
  it("refuses an upper-case sha256 in the manifest by saying the form is wrong, not by luck", () => {
    const root = tmp();
    install(root, "1.0.0", "x", { sha256: sha("x").toUpperCase() });
    expect(() => verifyInstalled(root, "1.0.0")).toThrow(/lower-case/);
  });
  it("lists versions in version order, whatever order the disk gives them", () => {
    const root = tmp();
    for (const v of ["2.0.0", "1.10.0", "1.9.0", "1.0.0-rc.1", "1.0.0", "0.10.0", "0.9.0", "10.0.0"]) install(root, v);
    expect(listInstalled(root)).toEqual(["0.9.0", "0.10.0", "1.0.0-rc.1", "1.0.0", "1.9.0", "1.10.0", "2.0.0", "10.0.0"]);
  });
});

describe("resolveSidecarRoot", () => {
  const WIN = { LOCALAPPDATA: "C:\\Users\\DMR\\AppData\\Local" };
  it("is the ordinary folder when the override is not set, or empty", () => {
    expect(SIDECAR_DIR_ENV).toBe("MEMELENS_SIDECAR_DIR");
    expect(resolveSidecarRoot("win32", WIN, "C:\\Users\\DMR")).toBe(sidecarRoot("win32", WIN, "C:\\Users\\DMR"));
    expect(resolveSidecarRoot("win32", { ...WIN, MEMELENS_SIDECAR_DIR: "" }, "C:\\Users\\DMR")).toBe(sidecarRoot("win32", WIN, "C:\\Users\\DMR"));
    expect(resolveSidecarRoot("linux", {}, "/home/d")).toBe(sidecarRoot("linux", {}, "/home/d"));
  });
  it("uses the override, unchanged, when it is an absolute path", () => {
    expect(resolveSidecarRoot("win32", { ...WIN, MEMELENS_SIDECAR_DIR: "D:\\engines\\memelens" }, "C:\\Users\\DMR")).toBe("D:\\engines\\memelens");
    expect(resolveSidecarRoot("win32", { MEMELENS_SIDECAR_DIR: "D:/engines/x" }, "C:\\Users\\DMR")).toBe("D:/engines/x"); // no LOCALAPPDATA needed
    expect(resolveSidecarRoot("win32", { MEMELENS_SIDECAR_DIR: "\\\\server\\share\\engines" }, "C:\\Users\\DMR")).toBe("\\\\server\\share\\engines");
    expect(resolveSidecarRoot("linux", { MEMELENS_SIDECAR_DIR: "/opt/engines" }, "/home/d")).toBe("/opt/engines");
    expect(resolveSidecarRoot("darwin", { MEMELENS_SIDECAR_DIR: "/opt/engines" }, "/Users/d")).toBe("/opt/engines");
  });
  it("refuses an override that is not absolute, instead of ignoring it", () => {
    for (const bad of ["engines", "./engines", "..\\engines", "~/engines", "C:engines", "\\engines", "/engines", " D:\\x"]) {
      expect(() => resolveSidecarRoot("win32", { ...WIN, MEMELENS_SIDECAR_DIR: bad }, "C:\\Users\\DMR"), bad).toThrow(LayoutError);
    }
    for (const bad of ["engines", "./engines", "../engines", "~/engines", "C:\\engines", " /opt/x"]) {
      expect(() => resolveSidecarRoot("linux", { MEMELENS_SIDECAR_DIR: bad }, "/home/d"), bad).toThrow(LayoutError);
    }
  });
  it("refuses '..' segments and NUL characters in an override", () => {
    for (const bad of ["D:\\a\\..\\b", "D:/a/../b", "D:\\a\\..", "D:\\a\u0000b"]) {
      expect(() => resolveSidecarRoot("win32", { MEMELENS_SIDECAR_DIR: bad }, "C:\\Users\\DMR"), JSON.stringify(bad)).toThrow(LayoutError);
    }
    for (const bad of ["/a/../b", "/a/..", "/a\u0000b"]) {
      expect(() => resolveSidecarRoot("linux", { MEMELENS_SIDECAR_DIR: bad }, "/home/d"), JSON.stringify(bad)).toThrow(LayoutError);
    }
    expect(resolveSidecarRoot("linux", { MEMELENS_SIDECAR_DIR: "/a/..b/c.." }, "/home/d")).toBe("/a/..b/c.."); // dots inside a name are fine
  });
  it("names the variable in the error", () => {
    expect(() => resolveSidecarRoot("linux", { MEMELENS_SIDECAR_DIR: "x" }, "/home/d")).toThrow(/MEMELENS_SIDECAR_DIR/);
  });
});
