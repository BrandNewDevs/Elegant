import { expect, it } from "vitest";
import type { SetupState } from "../setup/first-run-setup.js";
import { renderSetupPage, setupActionFromLink } from "./setup-page.js";

const todo: SetupState = {
  microphone: { status: "todo" },
  systemAudio: { status: "todo" },
  models: { status: "todo", fraction: 0 },
  ollama: { status: "todo" },
};

it("explains each macOS prompt before the button that triggers it", () => {
  const html = renderSetupPage(todo, "Elegant", false);
  for (const [heading, action] of [["Microphone", "microphone"], ["System audio", "system-audio"]]) {
    const section = html.slice(html.indexOf(`<h2>${heading}</h2>`));
    expect(section.indexOf("macOS asks whether to allow it")).toBeGreaterThan(-1);
    expect(section.indexOf("macOS asks")).toBeLessThan(section.indexOf(`href="setup:${action}"`));
  }
});

it("shows download progress and the message for a problem", () => {
  const html = renderSetupPage(
    { ...todo, models: { status: "working", fraction: 0.42 }, ollama: { status: "problem", message: "Run: ollama pull gemma3:4b" } },
    "Elegant",
    false,
  );
  expect(html).toContain('value="42"');
  expect(html).toContain("Run: ollama pull gemma3:4b");
});

it("offers Done only once setup is complete, and reads its links back", () => {
  expect(renderSetupPage(todo, "Elegant", false)).not.toContain("setup:done");
  expect(renderSetupPage(todo, "Elegant", true)).toContain("setup:done");
  expect(setupActionFromLink("setup:models")).toBe("models");
  expect(setupActionFromLink("setup:nonsense")).toBeUndefined();
});
