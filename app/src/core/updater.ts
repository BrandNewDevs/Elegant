import { DISPLAY_NAME } from "../config.js";
import { compareVersions, releasePageUrl } from "./update-check.js";

/** Where an update stands, as the windows and the menu bar show it. */
export type UpdateState =
  | { status: "idle" }
  | { status: "downloading"; version: string; percent: number }
  /** Downloaded and checked; installed by Restart, or at the next Quit. */
  | { status: "ready"; version: string }
  /** The download or the check failed; `url` is the release page, to get the update by hand. */
  | { status: "failed"; version: string; url: string; message: string };

/** What the updater needs from electron-updater, so the decisions here can be tested without it (`main/update-driver.ts` is the real one). */
export interface UpdateDriver {
  /** The version of the newest published release when it is newer than the running app, otherwise undefined. Rejects when GitHub cannot be reached or the release is not acceptable. */
  check(): Promise<string | undefined>;
  /** Downloads that release and resolves once macOS has checked its signature and staged it. `onProgress` gets 0 to 100. */
  download(onProgress: (percent: number) => void): Promise<void>;
  /** Quits the app, installs the staged update and starts the new version. */
  install(): void;
}

/** Why the app must not restart now: a Recording is running or finishing, or AI work is queued or running. */
export type RestartBlock = "recording" | "ai-work";

export type RestartResult = { ok: true } | { ok: false; reason: string };

export interface UpdaterOptions {
  /** The running app's version, as in package.json. */
  currentVersion: string;
  /** `owner/name` of the GitHub repository, for the release page. */
  repo: string;
  driver: UpdateDriver;
  /** Whether the person allows the check; asked before the request and again once it has answered. */
  enabled: () => boolean;
  /** What stops a restart right now, if anything. */
  restartBlock: () => RestartBlock | undefined;
  /** Whether the app is quitting to install, so nothing opens a window as the others close. */
  onInstalling?: (installing: boolean) => void;
  /** How long to wait for the release feed before giving up. */
  checkTimeoutMs?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

const REFUSED: Record<RestartBlock, string> = {
  recording: `A Recording is in progress. Stop it first, then restart to update.`,
  "ai-work": `${DISPLAY_NAME} is still transcribing or summarising a Meeting. Restart to update once that has finished.`,
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Looks for a newer published release once, at launch, downloads it in the background and, when it is ready, installs it
 * when the person restarts. It never restarts the app by itself, and refuses to while a Recording or AI work is going on.
 * Failing to reach GitHub is silent; a failed download or check of a release that exists is reported with its release page.
 */
export class Updater {
  private _state: UpdateState = { status: "idle" };
  private listeners: ((state: UpdateState) => void)[] = [];
  private started = false;
  private installing = false;

  constructor(private readonly options: UpdaterOptions) {}

  get state(): UpdateState {
    return this._state;
  }

  onChange(listener: (state: UpdateState) => void): void {
    this.listeners.push(listener);
  }

  /** The check at launch; later calls do nothing. It returns once the update is ready, failed or not needed. */
  async start(): Promise<void> {
    if (this.started || !this.options.enabled()) return;
    this.started = true;
    let version: string | undefined;
    try {
      version = await withTimeout(this.options.driver.check(), this.options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
    } catch {
      return;
    }
    if (!this.options.enabled() || version === undefined) return;
    if ((compareVersions(version, this.options.currentVersion) ?? 0) <= 0) return;
    this.set({ status: "downloading", version, percent: 0 });
    try {
      await this.options.driver.download(percent => {
        // The driver reports every chunk; the windows only need each whole percent.
        if (this._state.status === "downloading" && Math.round(percent) !== this._state.percent) {
          this.set({ status: "downloading", version, percent: Math.round(percent) });
        }
      });
      this.set({ status: "ready", version });
    } catch (err) {
      this.set({ status: "failed", version, url: releasePageUrl(this.options.repo, version), message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Restarts into the ready update, or says why it will not: nothing is ready, or a Recording or AI work is running. */
  restart(): RestartResult {
    if (this._state.status !== "ready" || this.installing) return { ok: false, reason: "There is no update to install." };
    const block = this.options.restartBlock();
    if (block) return { ok: false, reason: REFUSED[block] };
    this.installing = true;
    this.options.onInstalling?.(true);
    try {
      this.options.driver.install();
    } catch (err) {
      this.installing = false;
      this.options.onInstalling?.(false);
      return { ok: false, reason: `${DISPLAY_NAME} could not restart to update: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true };
  }

  private set(state: UpdateState): void {
    this._state = state;
    for (const listener of this.listeners) listener(state);
  }
}
