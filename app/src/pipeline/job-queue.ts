/** An AI job owns the model slot until its actual work settles, including after cancellation. */
export interface AIJob {
  id: string;
  owner: string;
  kind: string;
}

export interface AIJobState extends AIJob {
  status: "queued" | "running";
}

interface Entry {
  job: AIJob;
  controller: AbortController;
  task: (signal: AbortSignal) => Promise<unknown>;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  callerSettled: boolean;
}

function cancelled(): Error {
  const error = new Error("The AI job was cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * Serializes speech preparation, transcription and text generation without blocking Recording.
 * Cancelling active work rejects its caller promptly, but cannot release the model slot early:
 * native work may ignore AbortSignal and must settle (or its engine exit) before the next job.
 */
export class AIJobQueue {
  private readonly waiting: Entry[] = [];
  private active: Entry | undefined;
  private closed = false;
  private readonly listeners = new Set<(state: AIJobState[]) => void>();
  private readonly idleWaiters = new Set<() => void>();

  get snapshot(): AIJobState[] {
    return [
      ...(this.active ? [{ ...this.active.job, status: "running" as const }] : []),
      ...this.waiting.map(entry => ({ ...entry.job, status: "queued" as const })),
    ];
  }

  onChange(listener: (state: AIJobState[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  enqueue<T>(job: AIJob, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The AI queue is shutting down"));
    if (![job.id, job.owner, job.kind].every(value => typeof value === "string" && value.trim())) {
      return Promise.reject(new Error("An AI job needs an id, owner and kind"));
    }
    if (this.active?.job.id === job.id || this.waiting.some(entry => entry.job.id === job.id)) {
      return Promise.reject(new Error(`An AI job with id ${job.id} already exists`));
    }
    const result = new Promise<T>((resolve, reject) => {
      this.waiting.push({ job: { ...job }, controller: new AbortController(), task,
        resolve: value => resolve(value as T), reject, callerSettled: false });
    });
    this.pump();
    this.notify();
    return result;
  }

  cancel(id: string): boolean {
    if (this.active?.job.id === id) {
      if (this.active.controller.signal.aborted) return true;
      this.abort(this.active);
      this.notify();
      return true;
    }
    const index = this.waiting.findIndex(entry => entry.job.id === id);
    if (index < 0) return false;
    const [entry] = this.waiting.splice(index, 1);
    this.abort(entry!);
    this.notify();
    this.settleIdle();
    return true;
  }

  cancelOwner(owner: string): number {
    const ids = this.snapshot.filter(job => job.owner === owner).map(job => job.id);
    for (const id of ids) this.cancel(id);
    return ids.length;
  }

  /** Start shutdown before stopping the engine; await this promise after the engine has stopped. */
  shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.snapshot) this.cancel(job.id);
    return this.idle();
  }

  idle(): Promise<void> {
    if (!this.active && this.waiting.length === 0) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  private abort(entry: Entry): void {
    entry.controller.abort();
    if (entry.callerSettled) return;
    entry.callerSettled = true;
    entry.reject(cancelled());
  }

  private pump(): void {
    if (this.active) return;
    const next = this.waiting.shift();
    if (!next) { this.settleIdle(); return; }
    this.active = next;
    // Schedule work after enqueue has returned so callers can observe and cancel it first.
    void Promise.resolve().then(() => {
      next.controller.signal.throwIfAborted();
      return next.task(next.controller.signal);
    }).then(
      value => this.finish(next, { ok: true, value }),
      error => this.finish(next, { ok: false, error }),
    );
  }

  private finish(entry: Entry, outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): void {
    if (!entry.callerSettled) {
      entry.callerSettled = true;
      if (entry.controller.signal.aborted) entry.reject(cancelled());
      else if (!outcome.ok) entry.reject(outcome.error);
      else entry.resolve(outcome.value);
    }
    this.active = undefined;
    this.pump();
    this.notify();
    this.settleIdle();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      // A renderer observer cannot break model scheduling or another observer.
      try { listener(this.snapshot); } catch { /* Operational state remains available through snapshot. */ }
    }
  }

  private settleIdle(): void {
    if (this.active || this.waiting.length) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
