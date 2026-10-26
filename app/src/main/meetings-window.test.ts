import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCore } from "../core/app-core.js";
import { openStore, type Store } from "../store/store.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { fakePipeline, fixtureSummary, fixtureTranscript } from "../testing/fake-pipeline.js";
import type { MeetingChatGenerator } from "../pipeline/meeting-chat.js";
import type { MeetingsViewState } from "../shared/meetings-view-state.js";
import { Setup } from "../setup/setup.js";
import { SetupBridge } from "./setup-bridge.js";
import { MeetingsWindow } from "./meetings-window.js";

const electron = vi.hoisted(() => {
  type Handler = (event: { sender: unknown }, payload?: unknown) => unknown;
  const events = new Map<string, Handler>();
  const invokes = new Map<string, Handler>();
  class Window {
    destroyed = false;
    readonly handlers = new Map<string, () => void>();
    readonly webHandlers = new Map<string, () => void>();
    readonly webContents = {
      send: vi.fn((_channel: string, _payload: unknown) => {}),
      isDestroyed: () => this.destroyed,
      once: (event: string, handler: () => void) => { this.webHandlers.set(event, handler); },
      setWindowOpenHandler: vi.fn((_handler: () => { action: string }) => {}),
    };
    readonly show = vi.fn();
    readonly focus = vi.fn();
    readonly loadFile = vi.fn(async (_path: string) => {});
    constructor(readonly options: { webPreferences: { contextIsolation: boolean; sandbox: boolean; preload: string } }) { windows.push(this); }
    on(event: string, handler: () => void) { this.handlers.set(event, handler); }
    isDestroyed() { return this.destroyed; }
    loaded() { this.webHandlers.get("did-finish-load")?.(); }
    close() { this.destroyed = true; this.handlers.get("closed")?.(); this.webHandlers.get("destroyed")?.(); }
  }
  const windows: Window[] = [];
  return { windows, events, invokes, BrowserWindow: Window, nativeTheme: { shouldUseDarkColors: false },
    ipcMain: { on: (name: string, handler: Handler) => { events.set(name, handler); }, handle: (name: string, handler: Handler) => { invokes.set(name, handler); } },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })), showSaveDialog: vi.fn(async () => ({ canceled: true })), showErrorBox: vi.fn() },
    shell: { openExternal: vi.fn(async () => {}) },
  };
});
vi.mock("electron", () => electron);

type ChatInput = Parameters<MeetingChatGenerator>[0];
type ChatResult = Awaited<ReturnType<MeetingChatGenerator>>;
type TestWindow = typeof electron.windows[number];
interface TestContext { core: AppCore; store: Store; engine: FakeEngine; setup: Setup; window: TestWindow; id: number }
const contexts: TestContext[] = [];
const finishers: (() => void)[] = [];
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  finishers.push(() => resolve(fallback));
  return { promise, resolve };
}
function result(input: ChatInput): ChatResult {
  return { revision: input.expectedRevision,
    answer: { text: input.question.includes("You") ? "You proposed the walking skeleton." : "Speaker 1 agreed to the walking skeleton.", refs: input.question.includes("You") ? [0] : [1], sufficient: true },
    generation: { model: "local:test", promptVersion: "chat:test", calls: 1, elapsedMs: 1, retrievalMode: "full", exhaustive: true, retrievalCalls: 0 } };
}
function context(generate: MeetingChatGenerator = async input => { input.onStage?.("generating"); return result(input); }): TestContext {
  const store = openStore(":memory:");
  const engine = new FakeEngine();
  const core = new AppCore({ engine, store, pipeline: fakePipeline(), chat: generate });
  const setup = new Setup(engine, store, { speechModel: "tiny.en", modelsDirectory: "/tmp/synthetic-models", jobs: core.jobs,
    checkOllama: async () => ({ status: "ready" }) });
  const bridge = new SetupBridge(setup, { done: () => {}, openSettings: () => view.show({ settings: true }) });
  const view = new MeetingsWindow(core, setup, bridge);
  core.start(); engine.emit({ type: "ready", version: "0.1.0" });
  const id = store.createMeeting({ app: "Synthetic", startedAt: "2026-10-27T12:00:00Z" });
  store.saveTranscript(id, fixtureTranscript); store.saveSummary(id, fixtureSummary); store.setMeetingState(id, "done");
  view.show();
  const window = electron.windows.at(-1)!;
  window.loaded();
  const ctx = { core, store, engine, setup, window, id };
  contexts.push(ctx);
  emit(ctx, "meetings:select", id);
  return ctx;
}
function emit(ctx: TestContext, channel: string, value?: unknown, sender: unknown = ctx.window.webContents) {
  const handler = electron.events.get(channel);
  if (!handler) throw new Error(`Missing event ${channel}`);
  return handler({ sender }, value);
}
async function invoke(ctx: TestContext, channel: string, value?: unknown, sender: unknown = ctx.window.webContents): Promise<unknown> {
  const handler = electron.invokes.get(channel);
  if (!handler) throw new Error(`Missing invoke ${channel}`);
  return handler({ sender }, value);
}
function latest(ctx: TestContext): MeetingsViewState {
  return ctx.window.webContents.send.mock.calls.filter(([channel]) => channel === "meetings:state").at(-1)![1] as MeetingsViewState;
}
beforeEach(() => {
  electron.events.clear(); electron.invokes.clear(); electron.windows.length = 0;
  vi.clearAllMocks();
  electron.dialog.showMessageBox.mockResolvedValue({ response: 1 });
});
afterEach(async () => {
  for (const finish of finishers.splice(0)) finish();
  for (const ctx of contexts.splice(0)) { await ctx.core.stop(); ctx.window.close(); ctx.store.close(); }
});

describe("Meetings window application bridge", () => {
  it("publishes real chat progress and opens source references without retained audio", async () => {
    const ctx = context();
    expect(ctx.window.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true });
    expect(ctx.window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: "deny" });
    expect(latest(ctx).chat).toMatchObject({ available: true, revision: ctx.core.getTranscriptRevision(ctx.id), history: [] });
    expect(latest(ctx).selected?.audio).toBeNull();
    expect(latest(ctx).jobs).toEqual([]);
    await invoke(ctx, "meetings:send-question", { meetingId: ctx.id, requestId: "chat_1", question: "What did Speaker 1 agree to?" });
    await ctx.core.idle();
    expect(latest(ctx).chat?.history[0]).toMatchObject({ status: "completed", answer: { refs: [1] } });
    await expect(invoke(ctx, "meetings:open-reference", { meetingId: ctx.id, revision: latest(ctx).chat!.revision, refs: [1] })).resolves.toEqual([1]);
    emit(ctx, "meetings:rename", { meetingId: ctx.id, label: "Speaker 1", name: "Alice" });
    expect(latest(ctx).chat?.history[0]?.answer?.text).toBe("Alice agreed to the walking skeleton.");
  });

  it("refreshes current own-name chat presentation and preserves the Settings bridge", async () => {
    const ctx = context();
    ctx.setup.setUserName("Alex");
    await invoke(ctx, "meetings:send-question", { meetingId: ctx.id, requestId: "own_name", question: "What did Alex propose?" });
    await ctx.core.idle();
    expect(latest(ctx).chat?.history[0]).toMatchObject({ question: "What did Alex propose?", answer: { text: "Alex proposed the walking skeleton." } });
    ctx.setup.setUserName("Jordan");
    expect(latest(ctx).chat?.history[0]).toMatchObject({ question: "What did Jordan propose?", answer: { text: "Jordan proposed the walking skeleton." } });
    expect(ctx.core.getChatHistory(ctx.id)[0]?.question).toBe("What did You propose?");
    emit(ctx, "meetings:settings", true);
    expect(latest(ctx).settingsOpen).toBe(true);
    emit(ctx, "setup:ready");
    expect(ctx.window.webContents.send.mock.calls.some(([channel, value]) => channel === "setup:state" && (value as { userName: string }).userName === "Jordan")).toBe(true);
  });

  it("rejects every invoke from another web contents before reading or mutating Meeting data", async () => {
    const ctx = context();
    const sender = {};
    const send = vi.spyOn(ctx.core, "sendQuestion");
    const open = vi.spyOn(ctx.core, "openReference");
    const regenerate = vi.spyOn(ctx.core, "regenerateSummary");
    const remove = vi.spyOn(ctx.core, "deleteMeeting");
    const requests: [string, unknown][] = [
      ["meetings:send-question", { meetingId: ctx.id, requestId: "wrong", question: "What happened?" }],
      ["meetings:cancel-question", { meetingId: ctx.id, requestId: "wrong" }],
      ["meetings:clear-chat", ctx.id],
      ["meetings:open-reference", { meetingId: ctx.id, revision: ctx.core.getTranscriptRevision(ctx.id), refs: [1] }],
      ["meetings:cancel-job", { meetingId: ctx.id, jobId: "wrong" }],
      ["meetings:regenerate", ctx.id], ["meetings:delete", ctx.id],
    ];
    for (const [channel, value] of requests) await expect(invoke(ctx, channel, value, sender)).rejects.toThrow("cannot access Meetings");
    const pushes = ctx.window.webContents.send.mock.calls.length;
    emit(ctx, "meetings:ready", undefined, sender);
    emit(ctx, "meetings:select", ctx.id, sender);
    emit(ctx, "meetings:rename", { meetingId: ctx.id, label: "You", name: "Injected" }, sender);
    emit(ctx, "meetings:export", ctx.id, sender);
    expect(ctx.window.webContents.send).toHaveBeenCalledTimes(pushes);
    expect(send).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(ctx.core.getChatHistory(ctx.id)).toEqual([]);
  });

  it("rejects malformed requests before they can become model jobs", async () => {
    const generate = vi.fn<MeetingChatGenerator>(async input => result(input));
    const ctx = context(generate);
    const revision = ctx.core.getTranscriptRevision(ctx.id);
    const invalid: [string, unknown][] = [
      ["meetings:send-question", null], ["meetings:send-question", []],
      ["meetings:send-question", { meetingId: "1", requestId: "valid", question: "Question?" }],
      ["meetings:send-question", { meetingId: ctx.id, requestId: "invalid/id", question: "Question?" }],
      ["meetings:send-question", { meetingId: ctx.id, requestId: "x".repeat(129), question: "Question?" }],
      ["meetings:send-question", { meetingId: ctx.id, requestId: "valid", question: "x".repeat(2001) }],
      ["meetings:send-question", { meetingId: ctx.id, requestId: "valid", question: "   " }],
      ["meetings:send-question", { meetingId: ctx.id, requestId: "valid", question: "Question?", allowSummaryProcessing: true }],
      ["meetings:cancel-question", { meetingId: ctx.id, requestId: "invalid/id" }],
      ["meetings:clear-chat", 0], ["meetings:clear-chat", 1.5],
      ["meetings:regenerate", -1], ["meetings:delete", "1"],
      ["meetings:open-reference", { meetingId: ctx.id, revision: "not a revision", refs: [0] }],
      ["meetings:open-reference", { meetingId: ctx.id, revision, refs: [] }],
      ["meetings:open-reference", { meetingId: ctx.id, revision, refs: [0, 0] }],
      ["meetings:open-reference", { meetingId: ctx.id, revision, refs: [-1] }],
      ["meetings:open-reference", { meetingId: ctx.id, revision, refs: [0.5] }],
      ["meetings:open-reference", { meetingId: ctx.id, revision, refs: Array.from({ length: 4097 }, (_, index) => index) }],
      ["meetings:cancel-job", { meetingId: ctx.id, jobId: "../../" }],
    ];
    for (const [channel, value] of invalid) await expect(invoke(ctx, channel, value)).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
    expect(ctx.core.jobs.snapshot).toEqual([]);
    expect(ctx.core.getChatHistory(ctx.id)).toEqual([]);
    await expect(invoke(ctx, "meetings:open-reference", { meetingId: ctx.id, revision: "0".repeat(64), refs: [0] })).rejects.toThrow("older Transcript");
    await expect(invoke(ctx, "meetings:open-reference", { meetingId: ctx.id, revision, refs: [999] })).rejects.toThrow("Unknown");
  });

  it("routes Cancel and Clear without allowing late model output to restore history", async () => {
    let finish: (() => void) | undefined;
    const ctx = context(input => new Promise(resolve => { finish = () => resolve(result(input)); finishers.push(finish); }));
    await invoke(ctx, "meetings:send-question", { meetingId: ctx.id, requestId: "cancel", question: "What happened?" });
    await turn();
    await invoke(ctx, "meetings:cancel-question", { meetingId: ctx.id, requestId: "cancel" });
    expect(latest(ctx).chat?.history[0]?.status).toBe("cancelled");
    await invoke(ctx, "meetings:clear-chat", ctx.id);
    expect(latest(ctx).chat?.history).toEqual([]);
    finish!(); await ctx.core.idle();
    expect(latest(ctx).chat?.history).toEqual([]);
  });

  it("routes active chat job cancellation using its actual queued job identifier", async () => {
    let finish: (() => void) | undefined;
    const ctx = context(input => new Promise(resolve => { finish = () => resolve(result(input)); finishers.push(finish); }));
    await invoke(ctx, "meetings:send-question", { meetingId: ctx.id, requestId: "cancel_job", question: "What happened?" });
    await turn();
    const job = latest(ctx).jobs!.find(job => job.owner === `chat:${ctx.id}`)!;
    expect(job.kind).toBe("meeting-chat");
    await invoke(ctx, "meetings:cancel-job", { meetingId: ctx.id, jobId: job.id });
    await turn();
    expect(latest(ctx).chat?.history[0]?.status).toBe("cancelled");
    finish!(); await ctx.core.idle();
    expect(latest(ctx).chat?.history[0]?.answer).toBeNull();
  });

  it("cancels an active Summary only for its owning Meeting", async () => {
    const ctx = context();
    const held = deferred<void>(undefined);
    const work = ctx.core.jobs.enqueue({ id: "summary_job", owner: `meeting:${ctx.id}`, kind: "summary" }, () => held.promise);
    const cancelled = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await turn();
    await expect(invoke(ctx, "meetings:cancel-job", { meetingId: ctx.id + 1, jobId: "summary_job" })).rejects.toThrow("does not belong");
    await invoke(ctx, "meetings:cancel-job", { meetingId: ctx.id, jobId: "summary_job" });
    await cancelled;
    held.resolve(); await ctx.core.jobs.idle();
  });

  it("allows queued transcription cancellation but protects active native and Settings work", async () => {
    const ctx = context();
    const held = deferred<void>(undefined);
    const native = ctx.core.jobs.enqueue({ id: "native_job", owner: `meeting:${ctx.id}`, kind: "transcription" }, () => held.promise);
    await turn();
    await expect(invoke(ctx, "meetings:cancel-job", { meetingId: ctx.id, jobId: "native_job" })).rejects.toThrow("Active transcription");
    const queued = ctx.core.jobs.enqueue({ id: "queued_native", owner: `meeting:${ctx.id}`, kind: "transcription-and-summary" }, async () => {});
    const cancelled = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await invoke(ctx, "meetings:cancel-job", { meetingId: ctx.id, jobId: "queued_native" }); await cancelled;
    const preparation = ctx.core.jobs.enqueue({ id: "setup_job", owner: "setup", kind: "speech-model-preparation" }, async () => {});
    await expect(invoke(ctx, "meetings:cancel-job", { meetingId: ctx.id, jobId: "setup_job" })).rejects.toThrow("does not belong");
    held.resolve(); await native; await preparation; await ctx.core.jobs.idle();
  });
});
