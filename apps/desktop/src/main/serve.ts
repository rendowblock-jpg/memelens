import { extname } from "node:path";
import { CSP, resolveAppFile } from "./security";

export type Plan =
  | { status: 200; file: string; headers: Record<string, string> }
  | { status: 403 | 404 | 405 };

// The only file types the app ships. Anything else is refused, so a stray database or log can never be served.
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Decides what to answer for one request to the app:// origin. `isFile` says whether a path is an existing regular
 * file; it is passed in so this function does no I/O of its own.
 */
export function planResponse(root: string, method: string, url: string, isFile: (path: string) => boolean): Plan {
  if (method !== "GET" && method !== "HEAD") return { status: 405 };

  const file = resolveAppFile(root, url);
  if (file === null) return { status: 403 };

  // Checked before the file system is asked, so a refusal reveals nothing about which files exist.
  const type = TYPES[extname(file).toLowerCase()];
  if (type === undefined) return { status: 403 };

  if (!isFile(file)) return { status: 404 };

  return {
    status: 200,
    file,
    headers: {
      "Content-Type": type,
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
    },
  };
}
