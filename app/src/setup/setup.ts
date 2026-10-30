import type { AIJobQueue } from "../pipeline/job-queue.js";
import type { Engine, Permission } from "../engine/protocol.js";
import type { OllamaStatus } from "../pipeline/ollama.js";
import { USER_NAME_SETTING } from "../core/participants.js";
import type { Store } from "../store/store.js";
import { modelFiles, removeModelFiles, type ModelFile, type ModelKind } from "./model-files.js";

/** The store settings that remember what is already done, so a later launch never asks for it again. */
const PERMISSION_SETTING: Record<Permission, string> = {
  microphone: "permission.microphone",
  system_audio: "permission.system_audio",
};
const MODELS_READY_SETTING = "modelsReady";
/** Set by the earlier setup, which finished only once both permissions were granted and the models downloaded. */
const LEGACY_COMPLETE_SETTING = "setupComplete";

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
  /** Needed for Summaries, not for recording, so it never blocks onboarding. */
  ollama: Step;
}

export interface SetupOptions {
  speechModel: string;
  modelsDirectory: string;
  checkOllama: () => Promise<OllamaStatus>;
  jobs?: AIJobQueue;
  /** Why the models cannot be removed right now (a Recording or AI work is running), or undefined when nothing is using them. */
  busyReason?: () => string | undefined;
}

export type ModelChange = { ok: true } | { ok: false; reason: string };

const PERMISSION_DENIED: Record<Permission, string> = {
  microphone: "Microphone access was not allowed. Allow it in System Settings > Privacy & Security > Microphone, then try again.",
  system_audio:
    "System audio access was not allowed. Allow it in System Settings > Privacy & Security > Screen & System Audio Recording, then try again.",
};

const PERMISSION_STEP = { microphone: "microphone", system_audio: "systemAudio" } as const;

/**
 * What the app needs before its first Recording: the macOS permissions, the models and the Ollama check. Each step starts
 * only when the user asks for it, so a macOS prompt never appears before the app has explained it. A grant is remembered
 * in the store and checked again, without a prompt, each time the engine starts; the person is asked only for a
 * permission that is missing, and onboarding is for those alone. The models and Ollama never block onboarding.
 */
export class Setup {
  private _state: SetupState;
  private modelJob?: { resolve: () => void; reject: (error: Error) => void };
  private listeners: (() => void)[] = [];
  private checkedListeners: (() => void)[] = [];
  private nameListeners: (() => void)[] = [];
  private pendingChecks = new Set<Permission>();
  private _permissionsChecked = false;

  constructor(
    private readonly engine: Engine,
    private readonly store: Store,
    private readonly options: SetupOptions,
  ) {
    const remembered = store.getSetting(MODELS_READY_SETTING);
    const modelsReady = remembered === "true" || (remembered === undefined && this.finishedEarlierSetup());
    this._state = {
      microphone: { status: this.granted("microphone") ? "done" : "todo" },
      systemAudio: { status: this.granted("system_audio") ? "done" : "todo" },
      models: modelsReady ? { status: "done", fraction: 1 } : { status: "todo", fraction: 0 },
      ollama: { status: "todo" },
    };
    engine.onEvent((event) => {
      switch (event.type) {
        case "ready":
          this.verifyPermissions();
          break;
        case "permission_result": {
          const step = PERMISSION_STEP[event.permission];
          const checking = this.pendingChecks.delete(event.permission);
          if (checking || this._state[step].status === "working") this.applyPermission(event.permission, event.granted, checking);
          if (checking) this.finishChecks();
          break;
        }
        case "model_download_progress":
          if (this._state.models.status === "working") this.update({ models: { status: "working", fraction: event.fraction } });
          break;
        case "models_ready":
          this.modelJob?.resolve();
          this.modelJob = undefined;
          if (this._state.models.status === "working") {
            this.store.setSetting(MODELS_READY_SETTING, "true");
            this.update({ models: { status: "done", fraction: 1 } });
          }
          break;
        case "model_download_failed":
          this.modelJob?.reject(new Error("Speech model preparation failed. Check your connection and retry."));
          this.modelJob = undefined;
          if (this._state.models.status === "working") {
            this.update({ models: { status: "problem", fraction: this._state.models.fraction, message: `The download failed: ${event.message}. Check your connection and try again.` } });
          }
          break;
      }
    });
    engine.onExit(() => {
      this.modelJob?.reject(new Error("The engine stopped while preparing speech models"));
      this.modelJob = undefined;
      const stopped = { status: "problem", message: "The engine stopped. Restart the app and try again." } as const;
      const patch: Partial<SetupState> = {};
      for (const step of ["microphone", "systemAudio"] as const) if (this._state[step].status === "working") patch[step] = stopped;
      if (this._state.models.status === "working") patch.models = { ...stopped, fraction: this._state.models.fraction };
      this.update(patch);
      // With the engine gone nothing more can be checked, so launch carries on with what was remembered.
      this.pendingChecks.clear();
      this.finishChecks();
    });
  }

  get state(): SetupState {
    return this._state;
  }

  /** Whether both permissions are granted, which is all a Recording needs from onboarding. */
  get permissionsGranted(): boolean {
    return this._state.microphone.status === "done" && this._state.systemAudio.status === "done";
  }

  /** Whether the permissions remembered from earlier launches have been checked against macOS since the engine started. */
  get permissionsChecked(): boolean {
    return this._permissionsChecked;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** The person's own name, which Meetings show in place of "You". Empty until they give one. */
  get userName(): string {
    return this.store.getSetting(USER_NAME_SETTING) ?? "";
  }

  /** Remembers the person's name, or forgets it if it is blank. */
  setUserName(name: string): void {
    this.store.setSetting(USER_NAME_SETTING, name.trim());
    for (const l of this.nameListeners) l();
    this.update({});
  }

  /** Runs when the name changes, so what shows it can redraw. */
  onUserNameChange(listener: () => void): void {
    this.nameListeners.push(listener);
  }

  /** Runs once, when every remembered permission has been checked, so the caller knows whether onboarding is needed. */
  onPermissionsChecked(listener: () => void): void {
    if (this._permissionsChecked) listener();
    else this.checkedListeners.push(listener);
  }

  /**
   * Asks the engine, without a prompt, whether each permission is still allowed. The microphone is always checked; system
   * audio only after a grant was recorded, because the only way to check it is to start a tap, which prompts if the person
   * never answered.
   */
  verifyPermissions(): void {
    this._permissionsChecked = false;
    for (const permission of ["microphone", "system_audio"] as const) {
      if (permission === "system_audio" && !this.granted(permission)) continue;
      this.pendingChecks.add(permission);
      this.engine.send({ type: "check_permission", permission });
    }
    this.finishChecks();
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
    const prepare = () => new Promise<void>((resolve, reject) => {
      this.modelJob = { resolve, reject };
      this.engine.send({ type: "download_models", model: this.options.speechModel, modelsDirectory: this.options.modelsDirectory });
    });
    const work = this.options.jobs
      ? this.options.jobs.enqueue({ id: "setup-models", owner: "setup", kind: "speech-model-preparation" }, prepare)
      : prepare();
    void work.catch(() => this.update({ models: { status: "problem", fraction: 0, message: "Speech model preparation stopped. Restart the app and retry." } }));
  }

  /** What is downloaded, with its size, as it is on disk now. */
  listModels(): Promise<ModelFile[]> {
    return modelFiles(this.options.modelsDirectory);
  }

  /**
   * Deletes one kind of model, to free the space or to fetch it clean. It is refused while a download, a Recording or AI work
   * is using them. Afterwards the models count as not downloaded, so the next download fetches what is missing.
   */
  async removeModel(kind: ModelKind): Promise<ModelChange> {
    const busy = this._state.models.status === "working" ? "The models are downloading." : this.options.busyReason?.();
    if (busy) return { ok: false, reason: busy };
    try {
      await removeModelFiles(this.options.modelsDirectory, kind);
    } catch (error) {
      return { ok: false, reason: `Could not remove the model: ${error instanceof Error ? error.message : String(error)}` };
    }
    this.store.setSetting(MODELS_READY_SETTING, "false");
    this.update({ models: { status: "todo", fraction: 0 } });
    return { ok: true };
  }

  /** Removes one kind of model and downloads it again. */
  async redownloadModel(kind: ModelKind): Promise<ModelChange> {
    const removed = await this.removeModel(kind);
    if (removed.ok) this.downloadModels();
    return removed;
  }

  /** Checks that Ollama is running with the Summary model pulled. Safe to repeat once the user has fixed it. */
  async checkOllama(): Promise<void> {
    if (this._state.ollama.status === "working") return;
    this.update({ ollama: { status: "working" } });
    const result = await this.options.checkOllama();
    this.update({ ollama: result.status === "ready" ? { status: "done" } : { status: "problem", message: result.message } });
  }

  /** Whether the earlier setup finished here, so everything it asked for was already granted and need not be asked again. */
  private finishedEarlierSetup(): boolean {
    return this.store.getSetting(LEGACY_COMPLETE_SETTING) === "true";
  }

  private granted(permission: Permission): boolean {
    const remembered = this.store.getSetting(PERMISSION_SETTING[permission]);
    return remembered === "granted" || (remembered === undefined && this.finishedEarlierSetup());
  }

  private applyPermission(permission: Permission, granted: boolean, wasCheck: boolean): void {
    const step = PERMISSION_STEP[permission];
    const hadGrant = this.granted(permission);
    if (granted) {
      this.store.setSetting(PERMISSION_SETTING[permission], "granted");
      this.update({ [step]: { status: "done" } });
      return;
    }
    this.store.setSetting(PERMISSION_SETTING[permission], "denied");
    // A check of a permission that was never granted is just "not yet"; losing one that was granted is a problem to explain.
    this.update({ [step]: wasCheck && !hadGrant ? { status: "todo" } : { status: "problem", message: PERMISSION_DENIED[permission] } });
  }

  private finishChecks(): void {
    if (this.pendingChecks.size > 0 || this._permissionsChecked) return;
    this._permissionsChecked = true;
    for (const l of this.checkedListeners.splice(0)) l();
  }

  private requestPermission(permission: Permission, step: "microphone" | "systemAudio"): void {
    if (this._state[step].status === "working") return;
    this.update({ [step]: { status: "working" } });
    this.engine.send({ type: "request_permission", permission });
  }

  private update(patch: Partial<SetupState>): void {
    this._state = { ...this._state, ...patch };
    for (const l of this.listeners) l();
  }
}
