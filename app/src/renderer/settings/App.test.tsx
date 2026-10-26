import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { nothingDone, pushSetupState, withState } from "@/lib/test-electron";
import { SettingsPage } from "./App";

it("shows an allowed permission as allowed with nothing to press, and a missing one with an Allow button", () => {
  const act = pushSetupState(withState({ microphone: { status: "done" } }));
  render(<SettingsPage onBack={() => {}} />);
  expect(screen.getByText("Allowed")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Allow" })).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(act).toHaveBeenCalledWith("system-audio");
});

it("explains a permission that was turned off and links to System Settings", () => {
  const act = pushSetupState(withState({ microphone: { status: "problem", message: "Allow it in System Settings > Privacy & Security > Microphone." } }));
  render(<SettingsPage onBack={() => {}} />);
  expect(screen.getByText(/Privacy & Security > Microphone/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
  expect(act).toHaveBeenCalledWith("settings-microphone");
});

it("downloads the models from here, showing progress while it runs", () => {
  const act = pushSetupState(nothingDone);
  const { unmount } = render(<SettingsPage onBack={() => {}} />);
  expect(screen.getByText("Not downloaded")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Download models" }));
  expect(act).toHaveBeenCalledWith("models");
  unmount();

  pushSetupState(withState({ models: { status: "working", fraction: 0.42 } }));
  render(<SettingsPage onBack={() => {}} />);
  expect(screen.getByText("42% downloaded")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Model download" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download models" })).toBeNull();
});

it("shows downloaded models without offering the download again", () => {
  pushSetupState(withState({ models: { status: "done", fraction: 1 } }));
  render(<SettingsPage onBack={() => {}} />);
  expect(screen.getByText("Downloaded")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Download models|Try again/ })).toBeNull();
});

it("says why Summaries are not ready and checks Ollama again on request", () => {
  const act = pushSetupState(withState({ ollama: { status: "problem", message: "Run: ollama pull gemma3:4b" } }));
  render(<SettingsPage onBack={() => {}} />);
  expect(screen.getByText("Run: ollama pull gemma3:4b")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(act).toHaveBeenCalledWith("ollama");
});

it("goes back to the Meetings", () => {
  pushSetupState(nothingDone);
  let backs = 0;
  render(<SettingsPage onBack={() => backs++} />);
  fireEvent.click(screen.getByRole("button", { name: "Meetings" }));
  expect(backs).toBe(1);
});

it("changes the name from Settings, and only offers Save once it differs", () => {
  const send = pushSetupState({ ...nothingDone, userName: "Kenny" });
  render(<SettingsPage onBack={() => {}} />);
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Kenny");
  expect(save.disabled).toBe(true);

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ken" } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  expect(send.setUserName).toHaveBeenCalledWith("Ken");
});
