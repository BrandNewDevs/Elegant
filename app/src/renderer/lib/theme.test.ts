import { expect, it } from "vitest";
import { followSystemTheme } from "./theme";

function fakeQuery(matches: boolean) {
  const listeners: (() => void)[] = [];
  const query = {
    matches,
    addEventListener: (_: string, l: () => void) => listeners.push(l),
    removeEventListener: (_: string, l: () => void) => listeners.splice(listeners.indexOf(l), 1),
  } as unknown as MediaQueryList;
  return { query, set: (value: boolean) => { (query as { matches: boolean }).matches = value; listeners.forEach((l) => l()); }, listeners };
}

it("puts the dark class on the page while macOS is dark, and follows it when it changes", () => {
  const root = document.createElement("html");
  const { query, set } = fakeQuery(true);
  followSystemTheme(root, query);
  expect(root.classList.contains("dark")).toBe(true);
  set(false);
  expect(root.classList.contains("dark")).toBe(false);
  set(true);
  expect(root.classList.contains("dark")).toBe(true);
});

it("stops following once told to", () => {
  const root = document.createElement("html");
  const { query, set, listeners } = fakeQuery(false);
  const stop = followSystemTheme(root, query);
  stop();
  expect(listeners).toHaveLength(0);
  set(true);
  expect(root.classList.contains("dark")).toBe(false);
});
