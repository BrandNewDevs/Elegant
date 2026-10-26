/**
 * Apps whose microphone use should not count as a Meeting. The engine only reports processes inside a `.app`
 * bundle; everything else is already dropped there. Voice assistants and dictation-style apps are tuned on the demo pass (#10).
 */
export const DEFAULT_IGNORED_MIC_APPS = [
  "Siri",
  "Siri AI",
  "Dictation",
  "Wispr Flow",
];

export interface DetectionSettings {
  /** How long an app must hold the microphone before a Detection. A default to tune against real calls. */
  debounceMs: number;
  /** How long the Prompt waits for an answer before it counts as a decline. */
  promptTimeoutMs: number;
  /** Built-in ignores; tests may override via `detection.ignoredMicApps`. */
  ignoredMicApps: readonly string[];
}

export const DEFAULT_DETECTION: DetectionSettings = {
  debounceMs: 2000,
  promptTimeoutMs: 20_000,
  ignoredMicApps: DEFAULT_IGNORED_MIC_APPS,
};

export function micAppIsIgnored(app: string, ignored: readonly string[]): boolean {
  const name = app.toLowerCase();
  return ignored.some((entry) => entry.toLowerCase() === name);
}

/**
 * Turns the engine's per-process microphone edges into one Detection per call: any `.app` counts unless it is
 * ignored, helper processes of one app are folded together, and the app must hold the microphone for the debounce first.
 */
export class MicWatcher {
  /** Processes currently on the microphone, per app. */
  private readonly holders = new Map<string, Set<number>>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly settings: {
      debounceMs: number;
      ignoredMicApps: readonly string[];
      /** Extra ignores from settings on disk; asked on every edge so edits apply at once. */
      extraIgnoredApps: () => readonly string[];
    },
    private readonly handlers: {
      /** The app has held the microphone for the debounce. */
      detected(app: string): void;
      /** The last process of the app let go of the microphone. */
      released(app: string): void;
    },
  ) {}

  micStarted(app: string, pid: number): void {
    const ignored = [...this.settings.ignoredMicApps, ...this.settings.extraIgnoredApps()];
    if (micAppIsIgnored(app, ignored)) return;
    const holders = this.holders.get(app) ?? new Set<number>();
    this.holders.set(app, holders);
    const first = holders.size === 0;
    holders.add(pid);
    if (!first) return;
    this.pending.set(
      app,
      setTimeout(() => {
        this.pending.delete(app);
        this.handlers.detected(app);
      }, this.settings.debounceMs),
    );
  }

  micStopped(app: string, pid: number): void {
    const holders = this.holders.get(app);
    if (!holders?.delete(pid) || holders.size > 0) return;
    this.holders.delete(app);
    clearTimeout(this.pending.get(app));
    this.pending.delete(app);
    this.handlers.released(app);
  }

  /** Forgets everything, e.g. when the engine goes away. */
  reset(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.holders.clear();
  }
}
