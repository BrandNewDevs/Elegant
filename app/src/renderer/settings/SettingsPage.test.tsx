import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { UpdateState } from "../../core/updater";
import { nothingDone, pushSetupState, withState } from "@/lib/test-electron";
import { Toaster } from "@/components/ui/sonner";
import { SettingsPage, type SettingsSection } from "./SettingsPage";

/** Renders the page on one section; the section nav is covered on its own. */
function page(section: SettingsSection, props: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
  return render(<SettingsPage section={section} onSectionChange={() => {}} onBack={() => {}} {...props} />);
}

it("lists the sections, marks the open one, and asks to change section", () => {
  pushSetupState(nothingDone);
  const changes: string[] = [];
  render(<SettingsPage section="Models" onSectionChange={(s) => changes.push(s)} onBack={() => {}} />);
  expect(screen.getByRole("heading", { name: "Models" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Models" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Permissions" }));
  expect(changes).toEqual(["Permissions"]);
});

it("goes back to the Meetings from the back button and from Esc", () => {
  pushSetupState(nothingDone);
  const onBack = vi.fn();
  render(<SettingsPage section="General" onSectionChange={() => {}} onBack={onBack} />);
  fireEvent.click(screen.getByRole("button", { name: "Meetings" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onBack).toHaveBeenCalledTimes(2);
});

it("shows an allowed permission as allowed with nothing to press, and a missing one with an Allow button", () => {
  const act = pushSetupState(withState({ microphone: { status: "done" } }));
  page("Permissions");
  expect(screen.getByText("Allowed")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Allow" })).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(act).toHaveBeenCalledWith("system-audio");
});

it("explains a permission that was turned off and links to System Settings", () => {
  const act = pushSetupState(withState({ microphone: { status: "problem", message: "Allow it in System Settings > Privacy & Security > Microphone." } }));
  page("Permissions");
  expect(screen.getByText(/Privacy & Security > Microphone/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open System Settings for microphone" }));
  expect(act).toHaveBeenCalledWith("settings-microphone");
});

it("links each missing permission to its own System Settings pane, and not an allowed one", () => {
  const act = pushSetupState(withState({ microphone: { status: "done" } }));
  page("Permissions");
  expect(screen.queryByRole("button", { name: "Open System Settings for microphone" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open System Settings for system audio" }));
  expect(act).toHaveBeenCalledWith("settings-system-audio");
});

it("downloads the models from here, showing progress while it runs", () => {
  const act = pushSetupState(nothingDone);
  const { unmount } = page("Models");
  expect(screen.getByText("Not downloaded")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Download models" }));
  expect(act).toHaveBeenCalledWith("models");
  unmount();

  pushSetupState(withState({ models: { status: "working", fraction: 0.42 } }));
  page("Models");
  expect(screen.getByText("42% downloaded")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Model download" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download models" })).toBeNull();
});

it("shows downloaded models without offering the download again", () => {
  pushSetupState(withState({ models: { status: "done", fraction: 1 } }));
  page("Models");
  expect(screen.getByText("Downloaded")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Download models|Try again/ })).toBeNull();
});

it("says why Summaries are not ready and checks Ollama again on request", () => {
  const act = pushSetupState(withState({ ollama: { status: "problem", message: "Run: ollama pull gemma3:4b" } }));
  page("Models");
  expect(screen.getByText("Run: ollama pull gemma3:4b")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(act).toHaveBeenCalledWith("ollama");
});

it("turns Show in Dock on and off, starting from the stored setting", () => {
  const send = pushSetupState(nothingDone);
  const { rerender } = page("General", { showInDock: false });
  const toggle = screen.getByRole("switch", { name: "Show in Dock" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(send.setShowInDock).toHaveBeenLastCalledWith(true);

  rerender(<SettingsPage section="General" onSectionChange={() => {}} onBack={() => {}} showInDock />);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  expect(send.setShowInDock).toHaveBeenLastCalledWith(false);
});

it("turns Keep audio after transcription on and off, starting from the stored setting, and says it is off by default", () => {
  const send = pushSetupState(nothingDone);
  const { rerender } = page("General");
  const toggle = screen.getByRole("switch", { name: "Keep audio after transcription" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(send.setKeepAudio).toHaveBeenLastCalledWith(true);

  rerender(<SettingsPage section="General" onSectionChange={() => {}} onBack={() => {}} keepAudio />);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  expect(send.setKeepAudio).toHaveBeenLastCalledWith(false);
});

it("turns Check for updates on and off, starting from the stored setting", () => {
  const send = pushSetupState(nothingDone);
  const { rerender } = page("Updates", { checkForUpdates: false });
  const toggle = screen.getByRole("switch", { name: "Check for updates" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(send.setCheckForUpdates).toHaveBeenLastCalledWith(true);

  rerender(<SettingsPage section="Updates" onSectionChange={() => {}} onBack={() => {}} checkForUpdates />);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  expect(send.setCheckForUpdates).toHaveBeenLastCalledWith(false);
});

it("has Check for updates on by default", () => {
  pushSetupState(nothingDone);
  page("Updates");
  expect(screen.getByRole("switch", { name: "Check for updates" }).getAttribute("aria-checked")).toBe("true");
});

it("shows the app's version and no update when none is waiting", () => {
  pushSetupState(nothingDone);
  page("Updates", { appVersion: "0.1.3" });
  expect(screen.getByText("Elegant 0.1.3")).toBeTruthy();
  expect(screen.getByText("No update waiting")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
});

it("offers Restart to update for a ready update, and marks Updates in the section list", () => {
  pushSetupState(nothingDone);
  const ready: UpdateState = { status: "ready", version: "0.1.4" };
  page("Updates", { update: ready });
  expect(screen.getByText(/Version 0\.1\.4 is downloaded/)).toBeTruthy();
  expect(screen.getByLabelText("An update is ready")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
  expect(window.electron.meetings.restartForUpdate).toHaveBeenCalledTimes(1);
});

it("shows an update downloading, and a failed one with a link to its release page", () => {
  pushSetupState(nothingDone);
  const { unmount } = page("Updates", { update: { status: "downloading", version: "0.1.4", percent: 42 } });
  expect(screen.getByText("Downloading… 42%")).toBeTruthy();
  unmount();

  page("Updates", { update: { status: "failed", version: "0.1.4", url: "https://github.com/BrandNewDevs/Elegant/releases/tag/v0.1.4", message: "no" } });
  fireEvent.click(screen.getByRole("button", { name: "View release" }));
  expect(window.electron.meetings.openRelease).toHaveBeenCalledTimes(1);
});

it("asks for a name with the placeholder 'Your name', and only offers Save once it is typed", () => {
  const send = pushSetupState(nothingDone);
  page("General");
  const field = screen.getByLabelText("Name") as HTMLInputElement;
  expect(field.placeholder).toBe("Your name");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(field, { target: { value: "  Kenny " } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(send.setUserName).toHaveBeenCalledWith("  Kenny ");
});

it("shows the saved name, and Save stays off until it differs", () => {
  pushSetupState({ ...nothingDone, userName: "Kenny" });
  page("General");
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Kenny");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ken" } });
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
});

it("confirms a saved name with a toast", async () => {
  pushSetupState(nothingDone);
  render(<><SettingsPage section="General" onSectionChange={() => {}} onBack={() => {}} /><Toaster /></>);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Kenny" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Name saved")).toBeTruthy();
});

it("requires a saved key and explicit consent before selecting Gemini", async () => {
  pushSetupState({ ...nothingDone, ai: { provider: "ollama", geminiModel: "gemini-test", hasGeminiKey: true } });
  page("Models");
  const useGemini = screen.getByRole("button", { name: "Use Gemini" });
  expect(useGemini.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => fireEvent.click(useGemini));
  expect(window.electron.setup.configureAI).toHaveBeenCalledWith({ type: "select", provider: "gemini", consent: true });
});

it("clears an entered key after saving and exposes errors without changing provider", async () => {
  pushSetupState({ ...nothingDone, ai: { provider: "ollama", geminiModel: "gemini-test", hasGeminiKey: false } });
  page("Models");
  const field = screen.getByLabelText("Gemini API key") as HTMLInputElement;
  expect(field.type).toBe("password");
  fireEvent.change(field, { target: { value: "entered-key" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save key" })));
  expect(window.electron.setup.configureAI).toHaveBeenCalledWith({ type: "save-key", key: "entered-key" });
  expect(field.value).toBe("");
  expect(screen.getByRole("button", { name: "Use Gemini" }).hasAttribute("disabled")).toBe(true);
});

it("does not require Ollama when Gemini is selected and can switch back explicitly", async () => {
  pushSetupState({ ...nothingDone, ai: { provider: "gemini", geminiModel: "gemini-test", hasGeminiKey: true } });
  vi.mocked(window.electron.setup.configureAI).mockRejectedValue(new Error("Gemini quota reached"));
  page("Models");
  expect(screen.queryByRole("button", { name: "Check Ollama" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Test Gemini connection" })));
  expect(screen.getByRole("alert").textContent).toContain("Gemini quota reached");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use Ollama" })));
  expect(window.electron.setup.configureAI).toHaveBeenLastCalledWith({ type: "select", provider: "ollama" });
});
