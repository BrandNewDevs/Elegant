import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SetupViewState } from "../../shared/setup-view-state";
import { SetupApp } from "./App";

const todo: SetupViewState = {
  name: "Elegant",
  complete: false,
  state: {
    microphone: { status: "todo" },
    systemAudio: { status: "todo" },
    models: { status: "todo", fraction: 0 },
    ollama: { status: "todo" },
  },
};

beforeEach(() => {
  window.electron = {
    setup: {
      ready: vi.fn(),
      onState: (callback: (state: SetupViewState) => void) => {
        callback(todo);
        return () => {};
      },
      act: vi.fn(),
    },
    meetings: {} as Window["electron"]["meetings"],
    prompt: {} as Window["electron"]["prompt"],
  };
});

it("explains each macOS prompt before the button that triggers it", () => {
  render(<SetupApp />);
  expect(screen.getAllByText(/macOS asks whether to allow it/)).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Allow microphone" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Allow system audio" })).toBeTruthy();
});

it("shows download progress and the message for a problem", () => {
  window.electron.setup.onState = (callback) => {
    callback({
      ...todo,
      state: {
        ...todo.state,
        models: { status: "working", fraction: 0.42 },
        ollama: { status: "problem", message: "Run: ollama pull gemma3:4b" },
      },
    });
    return () => {};
  };
  render(<SetupApp />);
  expect(screen.getByText("42% downloaded")).toBeTruthy();
  expect(screen.getByText("Run: ollama pull gemma3:4b")).toBeTruthy();
});

it("offers Done only once setup is complete", () => {
  render(<SetupApp />);
  expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  window.electron.setup.onState = (callback) => {
    callback({ ...todo, complete: true });
    return () => {};
  };
  render(<SetupApp />);
  expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
});
