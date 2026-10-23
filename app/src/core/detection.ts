/** Apps whose use of the microphone means "probably a Meeting". Hard-coded for the demo; becomes a settings file later. */
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
  private readonly known: Set<string>;
  /** Processes currently on the microphone, per app. */
  private readonly holders = new Map<string, Set<number>>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly settings: Pick<DetectionSettings, "debounceMs" | "knownApps">,
    private readonly handlers: {
      /** The app has held the microphone for the debounce. */
      detected(app: string): void;
      /** The last process of the app let go of the microphone. */
      released(app: string): void;
    },
  ) {
    this.known = new Set(settings.knownApps.map((a) => a.toLowerCase()));
  }

  micStarted(app: string, pid: number): void {
    if (!this.known.has(app.toLowerCase())) return;
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
