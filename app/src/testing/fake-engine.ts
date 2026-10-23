import type { Engine, EngineCommand, EngineEvent, EngineExit } from "../engine/protocol.js";

/** A scripted engine for tests: the test decides what the engine reports and when it exits. */
export class FakeEngine implements Engine {
  started = false;
  readonly commands: EngineCommand[] = [];
  private eventHandlers: ((event: EngineEvent) => void)[] = [];
  private exitHandlers: ((exit: EngineExit) => void)[] = [];

  start(): void {
    this.started = true;
  }
  send(command: EngineCommand): void {
    this.commands.push(command);
  }
  onEvent(handler: (event: EngineEvent) => void): void {
    this.eventHandlers.push(handler);
  }
  onExit(handler: (exit: EngineExit) => void): void {
    this.exitHandlers.push(handler);
  }
  async stop(): Promise<void> {
    this.started = false;
  }

  /** Test control: the engine reports an event. */
  emit(event: EngineEvent): void {
    for (const h of this.eventHandlers) h(event);
  }
  /** Test control: the engine process ends. */
  exit(exit: EngineExit = { code: 1, signal: null }): void {
    this.started = false;
    for (const h of this.exitHandlers) h(exit);
  }
}
