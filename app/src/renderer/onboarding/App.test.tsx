import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { SetupViewState } from "../../shared/setup-view-state";
import { nothingDone, pushSetupState, withState } from "@/lib/test-electron";
import { OnboardingApp } from "./App";

it("welcomes a first-time user, then asks for the microphone only when they press the button", () => {
  const send = pushSetupState(nothingDone);
  render(<OnboardingApp />);
  expect(screen.getByRole("heading", { name: "Welcome to Elegant" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow microphone" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Get started" }));
  fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(screen.getByText(/macOS asks whether to allow it/)).toBeTruthy();
  expect(send).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Allow microphone" }));
  expect(send).toHaveBeenCalledWith("microphone");
});

it("skips a permission that is already allowed and goes to the one that is missing", () => {
  pushSetupState(withState({ microphone: { status: "done" } }));
  render(<OnboardingApp />);
  expect(screen.queryByRole("button", { name: "Allow microphone" })).toBeNull();
  expect(screen.getByRole("button", { name: "Allow system audio" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open System Settings" })).toBeTruthy();
});

it("shows the permission as allowed when macOS grants it, and Continue moves to the next one", () => {
  let push: (view: SetupViewState) => void = () => {};
  pushSetupState(nothingDone);
  window.electron.setup.onState = (callback) => {
    push = callback;
    callback(nothingDone);
    return () => {};
  };
  render(<OnboardingApp />);
  fireEvent.click(screen.getByRole("button", { name: "Get started" }));
  fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(screen.getByRole("button", { name: "Allow microphone" })).toBeTruthy();

  act(() => push(withState({ microphone: { status: "done" } })));
  expect(screen.getByRole("heading", { name: "Microphone allowed" })).toBeTruthy();
  expect(screen.getByText("You will not be asked again.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("button", { name: "Allow system audio" })).toBeTruthy();
});

it("explains a denied permission and offers System Settings and another try", () => {
  const send = pushSetupState(withState({ microphone: { status: "done" }, systemAudio: { status: "problem", message: "Allow it in System Settings > Privacy & Security." } }));
  render(<OnboardingApp />);
  expect(screen.getByText(/Allow it in System Settings/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
  expect(send).toHaveBeenCalledWith("settings-system-audio");
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(send).toHaveBeenCalledWith("system-audio");
});

it("offers System Settings before a decision too, for a person who already said no once", () => {
  const send = pushSetupState(nothingDone);
  render(<OnboardingApp />);
  fireEvent.click(screen.getByRole("button", { name: "Get started" }));
  fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
  expect(send).toHaveBeenCalledWith("settings-microphone");
  expect(send).not.toHaveBeenCalledWith("microphone");
});

it("shows a waiting state while macOS has its prompt open", () => {
  pushSetupState(withState({ microphone: { status: "done" }, systemAudio: { status: "working" } }));
  render(<OnboardingApp />);
  expect((screen.getByRole("button", { name: /Waiting for macOS/ }) as HTMLButtonElement).disabled).toBe(true);
});

it("finishes with Done, or sends the user to Settings for the models", () => {
  const send = pushSetupState(withState({ microphone: { status: "done" }, systemAudio: { status: "done" } }, true));
  render(<OnboardingApp />);
  expect(screen.queryByRole("button", { name: /Allow/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
  expect(send).toHaveBeenCalledWith("open-settings");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(send).toHaveBeenCalledWith("done");
});

it("asks for a name after the welcome, saves it, and moves on to the permissions", () => {
  const send = pushSetupState(nothingDone);
  render(<OnboardingApp />);
  fireEvent.click(screen.getByRole("button", { name: "Get started" }));
  expect(screen.getByRole("heading", { name: "What should we call you?" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow microphone" })).toBeNull();

  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "  Kenny " } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(send.setUserName).toHaveBeenCalledWith("  Kenny ");
  expect(screen.getByRole("button", { name: "Allow microphone" })).toBeTruthy();
});

it("lets the name be skipped, and starts with one already given", () => {
  const send = pushSetupState({ ...nothingDone, userName: "Priya" });
  render(<OnboardingApp />);
  fireEvent.click(screen.getByRole("button", { name: "Get started" }));
  expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Priya");

  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(send.setUserName).toHaveBeenCalledWith("");
});
