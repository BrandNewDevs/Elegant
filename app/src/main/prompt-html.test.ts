import { describe, expect, it } from "vitest";
import { NOT_NOW_URL, RECORD_URL, escapeHtml, promptHtml } from "./prompt-html.js";

describe("the Prompt page", () => {
  it("names the app that is using the microphone and offers Record and Not now", () => {
    const html = promptHtml("zoom.us");
    expect(html).toContain("zoom.us is using your microphone");
    expect(html).toContain(`href="${RECORD_URL}">Record<`);
    expect(html).toContain(`href="${NOT_NOW_URL}">Not now<`);
  });

  it("escapes the app name, which comes from a process path and is not trusted", () => {
    const html = promptHtml(`<img src=x onerror="alert(1)">`);
    expect(html).not.toContain("<img");
    expect(html).toContain(escapeHtml(`<img src=x onerror="alert(1)">`));
  });
});
