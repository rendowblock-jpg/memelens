import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SampleState } from "./empty";
import { EmptyDatabase } from "./empty-view";

const noop = (): void => {};
const html = (state: SampleState): string => renderToStaticMarkup(<EmptyDatabase state={state} onLoad={noop} />);
const plain = (markup: string): string => markup.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/\s+/g, " ").trim();
function button(markup: string, text: string): { disabled: boolean } | null {
  for (const m of markup.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)) if (plain(m[2]!) === text) return { disabled: /\bdisabled(=|\s|$)/.test(m[1]!) };
  return null;
}

describe("EmptyDatabase", () => {
  it("says there is no data, that the real-data adapter does not exist yet, and that the sample is made up", () => {
    const text = plain(html({ phase: "idle" }));
    expect(text).toContain("No data yet");
    expect(text).toContain("This copy of MemeLens has no data.");
    expect(text).toContain("A real-data adapter is not built yet.");
    expect(text).toContain("made-up sample");
    expect(text).toContain("SYNTHETIC DATA");
  });
  it("is marked for the tests and for assistive technology", () => {
    expect(html({ phase: "idle" })).toContain('data-testid="empty-state"');
  });
  it("offers the load button, ready to press", () => {
    expect(button(html({ phase: "idle" }), "Load the sample data")).toEqual({ disabled: false });
  });
  it("turns the button off while loading, and says it is loading", () => {
    expect(button(html({ phase: "loading" }), "Loading…")).toEqual({ disabled: true });
    expect(button(html({ phase: "loading" }), "Load the sample data")).toBeNull();
  });
  it("keeps it off once loaded, until the data replaces this screen", () => {
    expect(button(html({ phase: "loaded" }), "Opening the sample…")).toEqual({ disabled: true });
  });
  it("shows a failure as an alert with the reason, and lets the button be pressed again", () => {
    const h = html({ phase: "failed", message: "this database already holds data; the sample is only loaded into an empty one" });
    expect(h).toMatch(/role="alert"[^>]*>[^<]*Could not load the sample: this database already holds data/);
    expect(button(h, "Load the sample data")).toEqual({ disabled: false });
  });
  it("shows no alert when nothing went wrong", () => {
    for (const s of [{ phase: "idle" }, { phase: "loading" }, { phase: "loaded" }] as SampleState[]) expect(html(s)).not.toContain('role="alert"');
  });
  it("keeps the command-line way for people with a source checkout, folded away", () => {
    const h = html({ phase: "idle" });
    expect(h).toMatch(/<details[^>]*>\s*<summary[^>]*>From a source checkout<\/summary>/);
    expect(plain(h)).toContain("npm run memelens -- ingest packages/data/fixtures/sample.json --db <your database>");
  });
});
