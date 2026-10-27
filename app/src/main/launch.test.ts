import { describe, expect, it } from "vitest";
import { openStore } from "../store/store.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { Setup } from "../setup/setup.js";
import { Launch } from "./launch.js";

/** Stands in for the onboarding window, so the order in which windows open can be read off one list. */
function launch({ granted = false, atLogin = false } = {}) {
  const store = openStore(":memory:");
  if (granted) {
    store.setSetting("permission.microphone", "granted");
    store.setSetting("permission.system_audio", "granted");
  }
  const engine = new FakeEngine();
  const setup = new Setup(engine, store, { speechModel: "tiny", modelsDirectory: "/models", checkOllama: async () => ({ status: "ready" }) });
  const opened: string[] = [];
  let open = false;
  const closedListeners: (() => void)[] = [];
  const onboarding = {
    get isOpen() { return open; },
    show() { if (!open) opened.push("onboarding"); open = true; },
    onClosed(listener: () => void) { closedListeners.push(listener); },
  };
  const meetings = { show: () => void opened.push("meetings") };
  const l = new Launch(setup, meetings, onboarding, atLogin);
  l.start();
  return {
    l, opened, engine,
    /** The engine comes up and macOS answers each check. */
    engineReady(answers: { microphone?: boolean; system_audio?: boolean } = {}) {
      engine.emit({ type: "ready", version: "1" });
      for (const [permission, granted] of Object.entries(answers)) {
        engine.emit({ type: "permission_result", permission: permission as "microphone" | "system_audio", granted });
      }
    },
    closeOnboarding() { open = false; for (const c of closedListeners) c(); },
  };
}

describe("a first launch", () => {
  it("opens only onboarding, and nothing before macOS has reported", () => {
    const t = launch();
    expect(t.opened).toEqual([]);
    t.engineReady({ microphone: false });
    expect(t.opened).toEqual(["onboarding"]);
  });

  it("opens the Meetings window once onboarding is finished", () => {
    const t = launch();
    t.engineReady({ microphone: false });
    t.closeOnboarding();
    expect(t.opened).toEqual(["onboarding", "meetings"]);
  });

  it("opens the Meetings window too when onboarding is closed before it is finished", () => {
    const t = launch();
    t.engineReady({ microphone: false });
    t.closeOnboarding(); // the permissions are still missing
    expect(t.opened).toEqual(["onboarding", "meetings"]);
  });

  it("keeps requests to open the app on onboarding while it is open", () => {
    const t = launch();
    t.engineReady({ microphone: false });
    t.l.open();
    expect(t.opened).toEqual(["onboarding"]);
    t.closeOnboarding();
    t.l.open();
    expect(t.opened).toEqual(["onboarding", "meetings", "meetings"]);
  });

  it("ignores the activation macOS sends at launch until the permissions are reported", () => {
    const t = launch();
    t.l.activate();
    expect(t.opened).toEqual([]);
    t.engineReady({ microphone: false });
    t.l.activate();
    expect(t.opened).toEqual(["onboarding"]);
    t.closeOnboarding();
    t.l.activate();
    expect(t.opened).toEqual(["onboarding", "meetings", "meetings"]);
  });

  it("does not wait forever if the engine stops before it can report", () => {
    const t = launch();
    t.engine.emit({ type: "ready", version: "1" });
    t.engine.exit();
    expect(t.opened).toEqual(["onboarding"]);
  });

  it("opens only onboarding at login, and nothing after it closes", () => {
    const t = launch({ atLogin: true });
    t.engineReady({ microphone: false });
    t.closeOnboarding();
    expect(t.opened).toEqual(["onboarding"]);
  });
});

describe("a launch after onboarding", () => {
  it("opens the Meetings window at once, without waiting for macOS", () => {
    const t = launch({ granted: true });
    expect(t.opened).toEqual(["meetings"]);
    t.engineReady({ microphone: true, system_audio: true });
    expect(t.opened).toEqual(["meetings"]);
  });

  it("stays quiet at login", () => {
    const t = launch({ granted: true, atLogin: true });
    t.engineReady({ microphone: true, system_audio: true });
    expect(t.opened).toEqual([]);
  });

  it("opens onboarding over the Meetings window when a permission was revoked", () => {
    const t = launch({ granted: true });
    t.engineReady({ microphone: false, system_audio: true });
    expect(t.opened).toEqual(["meetings", "onboarding"]);
  });

  it("opens onboarding at login when a permission was revoked", () => {
    const t = launch({ granted: true, atLogin: true });
    t.engineReady({ microphone: false, system_audio: true });
    expect(t.opened).toEqual(["onboarding"]);
  });
});

describe("a launch where only the microphone was allowed already", () => {
  it("still opens onboarding for system audio, which is never checked without a remembered grant", () => {
    const t = launch();
    t.engineReady({ microphone: true });
    expect(t.opened).toEqual(["onboarding"]);
  });
});
