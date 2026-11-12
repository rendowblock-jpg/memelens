import { isAbsolute, join, relative } from "node:path";

/** The one origin the window is allowed to load. Everything else is refused. */
export const APP_ORIGIN = "app://memelens";

/** The policy sent with every file the app serves to its window: only its own scripts and styles, no network. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

function parse(url: string): URL | null {
  // The types say string, but `new URL(x)` turns any object into a string with its toString(); refuse those.
  if (typeof url !== "string") return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function onAppOrigin(u: URL): boolean {
  // For a scheme the URL parser does not know, the host keeps its case; Chromium would have lowercased it.
  return u.protocol === "app:" && u.hostname.toLowerCase() === "memelens" && u.port === "" && u.username === "" && u.password === "";
}

/** True only for URLs on the app's own origin (exact scheme and host, no port, no credentials). */
export function isAppUrl(url: string): boolean {
  const u = parse(url);
  return u !== null && onAppOrigin(u);
}

// A backslash is a path separator on Windows; control characters (NUL included) have no place in a file name.
const FORBIDDEN = /[\u0000-\u001f\u007f\\]/;

// Windows reads CON, PRN, AUX, NUL, COM0-9 and LPT0-9 as devices whatever the extension is ("nul.js", "NUL .txt"),
// including the superscript digits; CONIN$ and CONOUT$ are devices too.
const DEVICE = /^(?:con|prn|aux|nul|(?:com|lpt)[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;

/**
 * True for a path segment that Windows would not read as the name it says: surrounding spaces and trailing dots are
 * dropped, device names open the device, 8.3 short names (NAME~1.EXT) stand for a longer name, names starting with $
 * are file-system metadata, and < > " | ? * are not allowed in a name. Checked by name on every platform, so the
 * answer does not depend on where the app runs.
 */
function meansSomethingElseOnWindows(segment: string): boolean {
  if (segment !== segment.trim() || segment.endsWith(".")) return true;
  if (/[<>"|?*]/.test(segment) || /~[0-9]/.test(segment) || segment.startsWith("$")) return true;
  const base = (segment.split(".")[0] ?? "").trimEnd();
  return DEVICE.test(base);
}

/**
 * Maps a request URL to a file inside `root`, or null if the request must be refused. Does not check that the
 * file exists. The query string and fragment are ignored; `/` means index.html. The URL parser has already
 * removed plain and %2e dot segments; this refuses the rest (an encoded slash that decodes to `..`, backslashes,
 * drive letters and stream names, control characters, empty segments).
 */
export function resolveAppFile(root: string, url: string): string | null {
  const u = parse(url);
  if (u === null || !onAppOrigin(u)) return null;

  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (path === "" || path === "/") path = "/index.html";
  if (FORBIDDEN.test(path)) return null;

  const segments = path.split("/").slice(1);
  for (const s of segments) {
    if (s === "" || s === "." || s === ".." || s.includes(":")) return null;
    if (meansSomethingElseOnWindows(s)) return null;
  }

  const file = join(root, ...segments);
  // Belt and braces: the checks above already keep `file` inside `root`.
  const rel = relative(root, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return file;
}
