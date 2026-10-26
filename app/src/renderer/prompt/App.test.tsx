import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PromptApp } from "./App";

beforeEach(() => {
  window.electron = {
    prompt: {
      ready: vi.fn(),
      onState: (callback: (state: { app: string }) => void) => {
        callback({ app: "zoom.us" });
        return () => {};
      },
      choose: vi.fn(),
      resize: vi.fn(),
    },
    meetings: {} as Window["electron"]["meetings"],
    setup: {} as Window["electron"]["setup"],
  };
});

it("names the app that is using the microphone and offers Record, Not now and Never for this app", () => {
  render(<PromptApp />);
  expect(screen.getByText("zoom.us is using your microphone")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Record" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Never for this app" })).toBeTruthy();
});

it("escapes the app name in the heading", () => {
  window.electron.prompt.onState = (callback) => {
    callback({ app: `<img src=x onerror="alert(1)">` });
    return () => {};
  };
  render(<PromptApp />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText(/<img src=x onerror="alert\(1\)"> is using your microphone/)).toBeTruthy();
});
