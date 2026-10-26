/** Apps whose use of the microphone means "probably a Meeting" until the user edits the known-apps file, which starts out as this list. */
export const KNOWN_CALL_APPS = [
  "zoom.us",
  "Microsoft Teams",
  "MSTeams",
  "Slack",
  "FaceTime",
  // Browsers, for Google Meet. They cause false Detections; the Prompt is cheap to dismiss.
  "Google Chrome",
  "Safari",
  "Arc",
  "Firefox",
  "Brave Browser",
  "Microsoft Edge",
];

export interface DetectionSettings {
  /** How long a known app must hold the microphone before a Detection. A default to tune against real calls. */
  debounceMs: number;
  /** How long the Prompt waits for an answer before it counts as a decline. */
  promptTimeoutMs: number;
  knownApps: readonly string[];
}

export const DEFAULT_DETECTION: DetectionSettings = {
  debounceMs: 2000,
  promptTimeoutMs: 20_000,
  knownApps: KNOWN_CALL_APPS,
};

/**
 * Turns the engine's per-process microphone edges into one Detection per call: only listed apps count, helper
 * processes of one app are folded together, and the app must hold the microphone for the debounce first.
 */
export class MicWatcher {
  /** Processes currently on the microphone, per app. */
  private readonly holders = new Map<string, Set<number>>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly settings: { debounceMs: number; knownApps: () => readonly string[] },
    private readonly handlers: {
      /** The app has held the microphone for the debounce. */
      detected(app: string): void;
      /** The last process of the app let go of the microphone. */
      released(app: string): void;
    },
  ) {}

  micStarted(app: string, pid: number): void {
    const name = app.toLowerCase();
    if (!this.settings.knownApps().some((known) => known.toLowerCase() === name)) return;
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
