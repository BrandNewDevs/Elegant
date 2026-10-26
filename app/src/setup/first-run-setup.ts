import type { Engine, Permission } from "../engine/protocol.js";
import type { OllamaStatus } from "../pipeline/ollama.js";
import type { Store } from "../store/store.js";

/** The store setting that remembers setup is finished, so later launches skip it. */
const SETUP_COMPLETE_SETTING = "setupComplete";

export type StepStatus = "todo" | "working" | "done" | "problem";

export interface Step {
  status: StepStatus;
  /** What went wrong and what to do about it; set when `status` is "problem". */
  message?: string;
}

export interface SetupState {
  microphone: Step;
  systemAudio: Step;
  /** `fraction` is how much of the download is done, from 0 to 1. */
  models: Step & { fraction: number };
  /** Needed for Summaries, not for recording, so it never blocks `complete`. */
  ollama: Step;
}

export interface FirstRunSetupOptions {
  speechModel: string;
  modelsDirectory: string;
  checkOllama: () => Promise<OllamaStatus>;
}

const PERMISSION_DENIED: Record<Permission, string> = {
  microphone: "Microphone access was not allowed. Allow it in System Settings > Privacy & Security > Microphone, then try again.",
  system_audio:
    "System audio access was not allowed. Allow it in System Settings > Privacy & Security > Screen & System Audio Recording, then try again.",
};

/**
 * The first-run walk-through: the macOS permissions, the model download and the Ollama check. Each step starts only when
 * the user asks for it, so a macOS prompt never appears before the app has explained it. Setup is complete, and not
 * shown again, once both permissions are granted and the models are downloaded.
 */
export class FirstRunSetup {
  private _state: SetupState = {
    microphone: { status: "todo" },
    systemAudio: { status: "todo" },
    models: { status: "todo", fraction: 0 },
    ollama: { status: "todo" },
  };
  private listeners: (() => void)[] = [];

  constructor(
    private readonly engine: Engine,
    private readonly store: Store,
    private readonly options: FirstRunSetupOptions,
  ) {
    engine.onEvent((event) => {
      switch (event.type) {
        case "permission_result": {
          const step = event.permission === "microphone" ? "microphone" : "systemAudio";
          if (this._state[step].status !== "working") break;
          this.update({ [step]: event.granted ? { status: "done" } : { status: "problem", message: PERMISSION_DENIED[event.permission] } });
          break;
        }
        case "model_download_progress":
          if (this._state.models.status === "working") this.update({ models: { status: "working", fraction: event.fraction } });
          break;
        case "models_ready":
          if (this._state.models.status === "working") this.update({ models: { status: "done", fraction: 1 } });
          break;
        case "model_download_failed":
          if (this._state.models.status === "working") {
            this.update({ models: { status: "problem", fraction: this._state.models.fraction, message: `The download failed: ${event.message}. Check your connection and try again.` } });
          }
          break;
      }
    });
    engine.onExit(() => {
      const stopped = { status: "problem", message: "The engine stopped. Restart the app and try again." } as const;
      const patch: Partial<SetupState> = {};
      for (const step of ["microphone", "systemAudio"] as const) if (this._state[step].status === "working") patch[step] = stopped;
      if (this._state.models.status === "working") patch.models = { ...stopped, fraction: this._state.models.fraction };
      this.update(patch);
    });
  }

  get state(): SetupState {
    return this._state;
  }

  /** Whether setup has finished on this machine, now or on an earlier launch. */
  get complete(): boolean {
    return this.store.getSetting(SETUP_COMPLETE_SETTING) === "true";
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** The user chose to allow the microphone: macOS shows its prompt now. */
  requestMicrophone(): void {
    this.requestPermission("microphone", "microphone");
  }

  /** The user chose to allow system audio: macOS shows its prompt now. */
  requestSystemAudio(): void {
    this.requestPermission("system_audio", "systemAudio");
  }

  /** The user chose to download the models; progress arrives as the engine reports it. */
  downloadModels(): void {
    if (this._state.models.status === "working") return;
    this.update({ models: { status: "working", fraction: 0 } });
    this.engine.send({ type: "download_models", model: this.options.speechModel, modelsDirectory: this.options.modelsDirectory });
  }

  /** Checks that Ollama is running with the Summary model pulled. Safe to repeat once the user has fixed it. */
  async checkOllama(): Promise<void> {
    if (this._state.ollama.status === "working") return;
    this.update({ ollama: { status: "working" } });
    const result = await this.options.checkOllama();
    this.update({ ollama: result.status === "ready" ? { status: "done" } : { status: "problem", message: result.message } });
  }

  private requestPermission(permission: Permission, step: "microphone" | "systemAudio"): void {
    if (this._state[step].status === "working") return;
    this.update({ [step]: { status: "working" } });
    this.engine.send({ type: "request_permission", permission });
  }

  private update(patch: Partial<SetupState>): void {
    this._state = { ...this._state, ...patch };
    const { microphone, systemAudio, models } = this._state;
    if ([microphone, systemAudio, models].every((s) => s.status === "done")) this.store.setSetting(SETUP_COMPLETE_SETTING, "true");
    for (const l of this.listeners) l();
  }
}
