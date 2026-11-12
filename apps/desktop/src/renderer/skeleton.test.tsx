import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Skeleton, SKELETON_MAX_LINES } from "./skeleton";

const html = (what: string, lines?: number): string => renderToStaticMarkup(<Skeleton what={what} {...(lines === undefined ? {} : { lines })} />);
const count = (markup: string, cls: string): number => [...markup.matchAll(new RegExp(`class="${cls}[ "]`, "g"))].length;

describe("the loading skeleton", () => {
  it("is a busy status that says in words what is loading, for a screen reader", () => {
    const m = html("the token feed");
    expect(m).toContain('role="status"');
    expect(m).toContain('aria-busy="true"');
    expect(m).toMatch(/<span class="sr-only">Loading the token feed…<\/span>/);
  });

  it("draws the placeholder lines and hides every one of them from assistive technology", () => {
    const m = html("the ranking", 5);
    expect(count(m, "sk-line")).toBe(6); // a short heading line and five rows
    expect(count(m, "sk-line head")).toBe(1);
    expect([...m.matchAll(/class="sk-line[^"]*" aria-hidden="true"/g)]).toHaveLength(6);
  });

  it("draws at least one row and at most SKELETON_MAX_LINES, whatever it is asked for", () => {
    expect(count(html("x", 0), "sk-line")).toBe(2);
    expect(count(html("x", -3), "sk-line")).toBe(2);
    expect(count(html("x", 999), "sk-line")).toBe(SKELETON_MAX_LINES + 1);
    expect(count(html("x", 2.9), "sk-line")).toBe(3); // a fraction is rounded down, not drawn as a sliver
  });

  it("escapes what it is told, so a name can never inject markup", () => {
    const m = html('<img src=x onerror="boom()">');
    expect(m).not.toContain("<img");
    expect(m).toContain("&lt;img");
  });
});
