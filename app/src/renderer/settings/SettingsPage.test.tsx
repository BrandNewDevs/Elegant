import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

it("is a modal named for its section, closed from the close button and from Esc", () => {
  pushSetupState(nothingDone);
  const onBack = vi.fn();
  render(<SettingsPage section="General" onSectionChange={() => {}} onBack={onBack} />);
  expect(screen.getByRole("dialog", { name: "General" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
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

const absent = (kind: "speech" | "speaker") => ({ kind, present: false, bytes: 0 });
const present = (kind: "speech" | "speaker", bytes: number) => ({ kind, present: true, bytes });

it("downloads the models from here, showing progress while it runs", async () => {
  const act = pushSetupState(nothingDone);
  vi.mocked(window.electron.meetings.modelFiles).mockResolvedValue([absent("speech"), absent("speaker")]);
  const { unmount } = page("Models");
  expect(await screen.findAllByText("Not downloaded")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Download models" }));
  expect(act).toHaveBeenCalledWith("models");
  unmount();

  pushSetupState(withState({ models: { status: "working", fraction: 0.42 } }));
  page("Models");
  expect(screen.getByText("42% downloaded")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Model download" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download models" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Remove|Redownload/ })).toBeNull();
});

it("shows each downloaded model with its size, and offers Remove and Redownload but not the download", async () => {
  pushSetupState(withState({ models: { status: "done", fraction: 1 } }));
  vi.mocked(window.electron.meetings.modelFiles).mockResolvedValue([present("speech", 601e6), present("speaker", 11e6)]);
  page("Models");
  expect(await screen.findByText("Downloaded · 601 MB")).toBeTruthy();
  expect(screen.getByText("Downloaded · 11 MB")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "Redownload" })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /Download models|Try again/ })).toBeNull();
});

it("asks before removing a model, and only then removes that one", async () => {
  pushSetupState(withState({ models: { status: "done", fraction: 1 } }));
  const meetings = window.electron.meetings;
  vi.mocked(meetings.modelFiles).mockResolvedValue([present("speech", 601e6), present("speaker", 11e6)]);
  page("Models");
  await screen.findByText("Downloaded · 601 MB");

  fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
  const dialog = await screen.findByRole("dialog", { name: "Remove the speech model?" });
  expect(meetings.removeModel).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(meetings.removeModel).not.toHaveBeenCalled();

  fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove the speaker model?" })).getByRole("button", { name: "Remove" }));
  expect(meetings.removeModel).toHaveBeenCalledExactlyOnceWith("speaker");
});

it("redownloads a model after confirming", async () => {
  pushSetupState(withState({ models: { status: "done", fraction: 1 } }));
  const meetings = window.electron.meetings;
  vi.mocked(meetings.modelFiles).mockResolvedValue([present("speech", 601e6), present("speaker", 11e6)]);
  page("Models");
  await screen.findByText("Downloaded · 601 MB");
  fireEvent.click(screen.getAllByRole("button", { name: "Redownload" })[0]!);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Redownload the speech model?" })).getByRole("button", { name: "Redownload" }));
  expect(meetings.redownloadModel).toHaveBeenCalledExactlyOnceWith("speech");
});

it("says why a model could not be removed", async () => {
  pushSetupState(withState({ models: { status: "done", fraction: 1 } }));
  const meetings = window.electron.meetings;
  vi.mocked(meetings.modelFiles).mockResolvedValue([present("speech", 601e6), present("speaker", 11e6)]);
  vi.mocked(meetings.removeModel).mockResolvedValue({ ok: false, reason: "A Recording is in progress." });
  render(<><SettingsPage section="Models" onSectionChange={() => {}} onBack={() => {}} /><Toaster /></>);
  await screen.findByText("Downloaded · 601 MB");
  fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove the speech model?" })).getByRole("button", { name: "Remove" }));
  expect(await screen.findByText("A Recording is in progress.")).toBeTruthy();
});

it("says why Summaries are not ready and checks Ollama again on request", () => {
  const act = pushSetupState(withState({ ollama: { status: "problem", message: "Run: ollama pull gemma3:4b" } }));
  page("Providers");
  expect(screen.getByText("Run: ollama pull gemma3:4b")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(act).toHaveBeenCalledWith("ollama");
});

it("shows the chosen Appearance and asks to change it", () => {
  const send = pushSetupState(nothingDone);
  const { rerender } = page("General");
  const options = () => screen.getAllByRole("radio").map((o) => [o.textContent, o.getAttribute("aria-checked")]);
  expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
  expect(options()).toEqual([["System", "true"], ["Light", "false"], ["Dark", "false"]]);

  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(send.setAppearance).toHaveBeenLastCalledWith("dark");

  rerender(<SettingsPage section="General" onSectionChange={() => {}} onBack={() => {}} appearance="dark" />);
  expect(options()).toEqual([["System", "false"], ["Light", "false"], ["Dark", "true"]]);
  fireEvent.click(screen.getByRole("radio", { name: "Light" }));
  expect(send.setAppearance).toHaveBeenLastCalledWith("light");
});

/** Radix opens a Select on a key press on its trigger; happy-dom has no pointer capture for its click path. */
function openPicker(picker: HTMLElement) {
  picker.focus();
  fireEvent.keyDown(picker, { key: "Enter" });
}

it("picks the Summary model from the pulled ones, and cautions about any but the tested default", async () => {
  const send = pushSetupState(nothingDone);
  vi.mocked(window.electron.meetings.installedModels).mockResolvedValue(["llama3.2:3b", "gemma3:4b"]);
  const { rerender } = page("Providers");
  const picker = await screen.findByRole("combobox", { name: "Summary model" });
  expect(picker.textContent).toBe("gemma3:4b");
  expect(screen.queryByText(/Not tested/)).toBeNull();

  openPicker(picker);
  expect(await screen.findByRole("option", { name: "gemma3:4b" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("option", { name: "llama3.2:3b" }));
  expect(send.setSummaryModel).toHaveBeenLastCalledWith("llama3.2:3b");

  rerender(<SettingsPage section="Providers" onSectionChange={() => {}} onBack={() => {}} summaryModel="llama3.2:3b" />);
  expect(screen.getByText(/Not tested with/)).toBeTruthy();
});

it("keeps a chosen model in the list even when Ollama is not running or no longer has it", async () => {
  pushSetupState(nothingDone);
  page("Providers", { summaryModel: "qwen3:4b" });
  const picker = await screen.findByRole("combobox", { name: "Summary model" });
  expect(picker.textContent).toContain("qwen3:4b");
  openPicker(picker);
  expect(await screen.findByRole("option", { name: "qwen3:4b" })).toBeTruthy();
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
  page("Providers");
  const useGemini = screen.getByRole("button", { name: "Use Gemini" });
  expect(useGemini.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => fireEvent.click(useGemini));
  expect(window.electron.setup.configureAI).toHaveBeenCalledWith({ type: "select", provider: "gemini", consent: true });
});

it("clears an entered key after saving and exposes errors without changing provider", async () => {
  pushSetupState({ ...nothingDone, ai: { provider: "ollama", geminiModel: "gemini-test", hasGeminiKey: false } });
  page("Providers");
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
  page("Providers");
  expect(screen.queryByRole("button", { name: "Check Ollama" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Test Gemini connection" })));
  expect(screen.getByRole("alert").textContent).toContain("Gemini quota reached");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use Ollama" })));
  expect(window.electron.setup.configureAI).toHaveBeenLastCalledWith({ type: "select", provider: "ollama" });
});

it("lists Providers as a section, and keeps the speech and speaker models apart from the AI providers", () => {
  pushSetupState({ ...nothingDone, ai: { provider: "ollama", geminiModel: "gemini-test", hasGeminiKey: false } });
  const changes: string[] = [];
  const { rerender } = render(<SettingsPage section="Models" onSectionChange={(s) => changes.push(s)} onBack={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  expect(changes).toEqual(["Providers"]);
  expect(screen.getByText("Speech model")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Gemini" })).toBeNull();
  expect(screen.queryByText("Summary model")).toBeNull();

  rerender(<SettingsPage section="Providers" onSectionChange={() => {}} onBack={() => {}} />);
  expect(screen.getByRole("region", { name: "Ollama" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Gemini" })).toBeTruthy();
  expect(screen.queryByText("Speech model")).toBeNull();
});

it("marks the provider in use, and shows Ollama's readiness only while Ollama is the one", () => {
  pushSetupState({ ...nothingDone, ai: { provider: "ollama", geminiModel: "gemini-test", hasGeminiKey: true } });
  const { unmount } = page("Providers");
  expect(within(screen.getByRole("region", { name: "Ollama" })).getByText("In use")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Gemini" })).queryByText("In use")).toBeNull();
  expect(screen.getByRole("button", { name: "Check Ollama" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Use Ollama" })).toBeNull();

  unmount();

  pushSetupState({ ...nothingDone, ai: { provider: "gemini", geminiModel: "gemini-test", hasGeminiKey: true } });
  page("Providers");
  expect(within(screen.getByRole("region", { name: "Gemini" })).getByText("In use")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Check Ollama" })).toBeNull();
  expect(screen.getByRole("button", { name: "Use Ollama" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Use Gemini" })).toBeNull();
});

it("keeps the key that was typed when saving it fails", async () => {
  pushSetupState({ ...nothingDone, ai: { provider: "ollama", geminiModel: "gemini-test", hasGeminiKey: false } });
  vi.mocked(window.electron.setup.configureAI).mockRejectedValue(new Error("The keychain is locked"));
  page("Providers");
  const field = screen.getByLabelText("Gemini API key") as HTMLInputElement;
  fireEvent.change(field, { target: { value: "entered-key" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save key" })));
  expect(screen.getByRole("alert").textContent).toContain("The keychain is locked");
  expect(field.value).toBe("entered-key");
});

const gemini = (extra = {}) => ({ ...nothingDone, ai: { provider: "ollama" as const, geminiModel: "gemini-2.5-flash", hasGeminiKey: true, ...extra } });

it("loads the Gemini models from the API and picks one without saving a separate field", async () => {
  pushSetupState(gemini());
  vi.mocked(window.electron.setup.geminiModels).mockResolvedValue([{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }, { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }]);
  page("Providers");
  const picker = await screen.findByRole("combobox", { name: "Gemini text model" });
  expect(window.electron.setup.geminiModels).toHaveBeenCalledTimes(1);
  expect(picker.textContent).toContain("gemini-2.5-flash");
  expect(screen.queryByRole("button", { name: "Save model" })).toBeNull();

  openPicker(picker);
  expect(await screen.findByRole("option", { name: "gemini-2.5-pro" })).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("option", { name: "gemini-2.5-pro" })));
  expect(window.electron.setup.configureAI).toHaveBeenCalledWith({ type: "model", model: "gemini-2.5-pro" });
});

it("asks Google for models only once a key is saved, and says so until then", () => {
  pushSetupState(gemini({ hasGeminiKey: false }));
  page("Providers");
  const picker = screen.getByRole("combobox", { name: "Gemini text model" });
  expect(picker.hasAttribute("disabled")).toBe(true);
  expect(picker.textContent).toContain("gemini-2.5-flash");
  expect(window.electron.setup.geminiModels).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Refresh models" }).hasAttribute("disabled")).toBe(true);
});

it("keeps the saved model visible when Google no longer lists it, and when the list is still loading", async () => {
  pushSetupState(gemini({ geminiModel: "gemini-old" }));
  vi.mocked(window.electron.setup.geminiModels).mockResolvedValue([{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }]);
  page("Providers");
  const picker = screen.getByRole("combobox", { name: "Gemini text model" });
  expect(picker.textContent).toContain("gemini-old");
  await vi.waitFor(() => expect(window.electron.setup.geminiModels).toHaveBeenCalled());
  openPicker(picker);
  expect(await screen.findByRole("option", { name: "gemini-old (not listed)" })).toBeTruthy();
});

it("says why the model list could not be loaded and asks again on Refresh", async () => {
  pushSetupState(gemini());
  vi.mocked(window.electron.setup.geminiModels).mockRejectedValueOnce(new Error("Gemini access was denied. Check your API key.")).mockResolvedValue([{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }]);
  page("Providers");
  expect(await screen.findByText("Gemini access was denied. Check your API key.")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh models" })));
  expect(window.electron.setup.geminiModels).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("Gemini access was denied. Check your API key.")).toBeNull();
});

it("confirms a provider change with a toast, not with text in the page", async () => {
  pushSetupState(gemini());
  vi.mocked(window.electron.setup.configureAI).mockResolvedValue("Gemini key removed. New Gemini requests need a key.");
  render(<><SettingsPage section="Providers" onSectionChange={() => {}} onBack={() => {}} /><Toaster /></>);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove key" })));
  const toast = await screen.findByText("Gemini key removed. New Gemini requests need a key.");
  expect(toast.closest("[data-sonner-toast]")).not.toBeNull();
  expect(toast.closest("section[aria-label='Gemini']")).toBeNull();
});

it("shows a failed provider change as an alert beside the controls, with no toast", async () => {
  pushSetupState(gemini({ hasGeminiKey: false }));
  vi.mocked(window.electron.setup.configureAI).mockRejectedValue(new Error("The keychain is locked"));
  render(<><SettingsPage section="Providers" onSectionChange={() => {}} onBack={() => {}} /><Toaster /></>);
  fireEvent.change(screen.getByLabelText("Gemini API key"), { target: { value: "entered-key" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save key" })));
  expect(screen.getByRole("alert").textContent).toContain("The keychain is locked");
  expect(document.querySelector("[data-sonner-toast]")).toBeNull();
});

const listed = [{ id: "gemini-flash", label: "Flash" }, { id: "gemini-argon", label: "Argon" }, { id: "gemini-pro", label: "Pro" }];

it("finds the usable models from a button, and says what it found in a toast", async () => {
  pushSetupState(gemini());
  vi.mocked(window.electron.setup.geminiModels).mockResolvedValue(listed);
  vi.mocked(window.electron.setup.findGeminiModels).mockResolvedValue("Found 1 model that works on your key.");
  render(<><SettingsPage section="Providers" onSectionChange={() => {}} onBack={() => {}} /><Toaster /></>);
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Find usable models" })));
  expect(window.electron.setup.findGeminiModels).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Found 1 model that works on your key.")).toBeTruthy();
});

it("shows progress with a Stop button while it runs, and nothing else to start", async () => {
  pushSetupState(gemini({ finding: { done: 3, total: 10 } }));
  vi.mocked(window.electron.setup.geminiModels).mockResolvedValue(listed);
  page("Providers");
  expect(await screen.findByText("Trying models… 3 of 10")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Trying models" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Find usable models/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh models" }).hasAttribute("disabled")).toBe(true);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
  expect(window.electron.setup.stopFindingGeminiModels).toHaveBeenCalledTimes(1);
});

it("offers only the models that answered, marks a saved one that did not, and can show them all", async () => {
  pushSetupState(gemini({ geminiModel: "gemini-argon", usableModels: ["gemini-flash"] }));
  vi.mocked(window.electron.setup.geminiModels).mockResolvedValue(listed);
  page("Providers");
  const picker = await screen.findByRole("combobox", { name: "Gemini text model" });
  await vi.waitFor(() => expect(window.electron.setup.geminiModels).toHaveBeenCalled());
  expect(screen.getByText("1 of the listed models answered on your key.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Find usable models again" })).toBeTruthy();
  openPicker(picker);
  expect(await screen.findByRole("option", { name: "gemini-flash" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "gemini-argon (didn't answer)" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "gemini-pro" })).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });

  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show all models" })));
  openPicker(picker);
  expect(await screen.findByRole("option", { name: "gemini-pro" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "gemini-argon" })).toBeTruthy();
});

it("says why trying the models failed, in a toast", async () => {
  pushSetupState(gemini());
  vi.mocked(window.electron.setup.geminiModels).mockResolvedValue(listed);
  vi.mocked(window.electron.setup.findGeminiModels).mockRejectedValue(new Error("Could not reach Gemini. Check your connection and retry."));
  render(<><SettingsPage section="Providers" onSectionChange={() => {}} onBack={() => {}} /><Toaster /></>);
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Find usable models" })));
  expect(await screen.findByText("Could not reach Gemini. Check your connection and retry.")).toBeTruthy();
});
