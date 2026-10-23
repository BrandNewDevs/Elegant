import { spawn, type ChildProcess } from "node:child_process";
import { encodeCommand, parseEngineEvent } from "./protocol.js";
import type { Engine, EngineCommand, EngineEvent, EngineExit } from "./protocol.js";

export interface ProcessEngineOptions {
  command: string;
  args?: string[];
  /** How long stop() waits for a clean exit before killing the process. */
  killAfterMs?: number;
}

/** Runs the Swift engine as a child process and speaks the JSON-lines protocol over its stdio. */
export class ProcessEngine implements Engine {
  private child: ChildProcess | undefined;
  private exited = false;
  private eventHandlers: ((event: EngineEvent) => void)[] = [];
  private exitHandlers: ((exit: EngineExit) => void)[] = [];

  constructor(private readonly options: ProcessEngineOptions) {}

  start(): void {
    this.exited = false;
    const child = spawn(this.options.command, this.options.args ?? [], { stdio: ["pipe", "pipe", "inherit"] });
    this.child = child;

    let pending = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) this.dispatchLine(line);
      }
    });

    // The engine may already be gone when we write; that surfaces through the exit event instead.
    child.stdin!.on("error", () => {});

    child.on("error", (err) => {
      this.emit({ type: "error", message: `could not run engine ${this.options.command}: ${err.message}` });
      this.finish({ code: null, signal: null });
    });
    child.on("close", (code, signal) => this.finish({ code, signal }));
  }

  send(command: EngineCommand): void {
    if (!this.child || this.exited) return;
    this.child.stdin!.write(encodeCommand(command));
  }

  onEvent(handler: (event: EngineEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  onExit(handler: (exit: EngineExit) => void): void {
    this.exitHandlers.push(handler);
  }

  stop(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const killer = setTimeout(() => child.kill("SIGKILL"), this.options.killAfterMs ?? 3000);
      child.once("close", () => {
        clearTimeout(killer);
        resolve();
      });
      this.send({ type: "shutdown" });
    });
  }

  private dispatchLine(line: string): void {
    try {
      this.emit(parseEngineEvent(line));
    } catch (err) {
      this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private emit(event: EngineEvent): void {
    for (const h of this.eventHandlers) h(event);
  }

  private finish(exit: EngineExit): void {
    if (this.exited) return;
    this.exited = true;
    for (const h of this.exitHandlers) h(exit);
  }
}
