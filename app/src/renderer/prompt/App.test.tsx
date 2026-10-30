import { fireEvent, render, screen } from "@testing-library/react";
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

it("asks whether to record without naming the app, and offers Record, Never for this app and Close", () => {
  render(<PromptApp />);
  expect(screen.getByText("Record this Meeting?")).toBeTruthy();
  expect(screen.queryByText(/zoom\.us/)).toBeNull();
  expect(screen.getByRole("button", { name: "Record" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Never for this app" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
});

it("sends each choice from its own button", () => {
  render(<PromptApp />);
  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  fireEvent.click(screen.getByRole("button", { name: "Never for this app" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(vi.mocked(window.electron.prompt.choose).mock.calls).toEqual([["record"], ["never"], ["close"]]);
});

it("closes on Escape", () => {
  render(<PromptApp />);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(window.electron.prompt.choose).toHaveBeenCalledWith("close");
});
