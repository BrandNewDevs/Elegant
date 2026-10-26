import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { SetupViewState } from "../../shared/setup-view-state";
import { nothingDone, pushSetupState, withState } from "@/lib/test-electron";
import { SettingsDialog } from "./SettingsDialog";

it("shows an allowed permission as allowed with nothing to press, and a missing one with an Allow button", () => {
  const act = pushSetupState(withState({ microphone: { status: "done" } }));
  render(<SettingsDialog open onOpenChange={() => {}} />);
  expect(screen.getByText("Allowed")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Allow" })).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(act).toHaveBeenCalledWith("system-audio");
});

it("explains a permission that was turned off and links to System Settings", () => {
  const act = pushSetupState(withState({ microphone: { status: "problem", message: "Allow it in System Settings > Privacy & Security > Microphone." } }));
  render(<SettingsDialog open onOpenChange={() => {}} />);
  expect(screen.getByText(/Privacy & Security > Microphone/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
  expect(act).toHaveBeenCalledWith("settings-microphone");
});

it("downloads the models from here, showing progress while it runs", () => {
  const act = pushSetupState(nothingDone);
  const { unmount } = render(<SettingsDialog open onOpenChange={() => {}} />);
  expect(screen.getByText("Not downloaded")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Download models" }));
  expect(act).toHaveBeenCalledWith("models");
  unmount();

  pushSetupState(withState({ models: { status: "working", fraction: 0.42 } }));
  render(<SettingsDialog open onOpenChange={() => {}} />);
  expect(screen.getByText("42% downloaded")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Model download" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download models" })).toBeNull();
});

it("shows downloaded models without offering the download again", () => {
  pushSetupState(withState({ models: { status: "done", fraction: 1 } }));
  render(<SettingsDialog open onOpenChange={() => {}} />);
  expect(screen.getByText("Downloaded")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Download models|Try again/ })).toBeNull();
});

it("says why Summaries are not ready and checks Ollama again on request", () => {
  const act = pushSetupState(withState({ ollama: { status: "problem", message: "Run: ollama pull gemma3:4b" } }));
  render(<SettingsDialog open onOpenChange={() => {}} />);
  expect(screen.getByText("Run: ollama pull gemma3:4b")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(act).toHaveBeenCalledWith("ollama");
});

it("is a dialog that closes from its close button", () => {
  pushSetupState(nothingDone);
  const changes: boolean[] = [];
  render(<SettingsDialog open onOpenChange={(open) => changes.push(open)} />);
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(changes).toEqual([false]);
});

it("shows nothing while it is closed", () => {
  pushSetupState(nothingDone);
  render(<SettingsDialog open={false} onOpenChange={() => {}} />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("changes the name from Settings, and only offers Save once it differs", () => {
  const send = pushSetupState({ ...nothingDone, userName: "Kenny" });
  render(<SettingsDialog open onOpenChange={() => {}} />);
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Kenny");
  expect(save.disabled).toBe(true);

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ken" } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  expect(send.setUserName).toHaveBeenCalledWith("Ken");
});

it("does not put focus on the close button when it opens, even though the content arrives later", () => {
  let push: (view: SetupViewState) => void = () => {};
  pushSetupState(nothingDone);
  window.electron.setup.onState = (callback) => {
    push = callback;
    return () => {};
  };
  render(<SettingsDialog open onOpenChange={() => {}} />);
  expect(screen.getByRole("dialog")).toBe(document.activeElement);
  expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Close" }));

  act(() => push(nothingDone));
  expect(screen.getByRole("dialog")).toBe(document.activeElement);
});
