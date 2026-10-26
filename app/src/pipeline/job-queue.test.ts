import { describe, expect, it, vi } from "vitest";
import { AIJobQueue } from "./job-queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const job = (id: string, owner = "meeting:1") => ({ id, owner, kind: "summary" });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

describe("managed AI jobs", () => {
  it("runs one task at a time and exposes queued work without changing caller results", async () => {
    const queue = new AIJobQueue();
    const first = deferred<string>();
    const order: string[] = [];
    const a = queue.enqueue(job("a"), async () => { order.push("a"); return first.promise; });
    const b = queue.enqueue(job("b"), async () => { order.push("b"); return "second"; });
    await turn();
    expect(order).toEqual(["a"]);
    expect(queue.snapshot).toEqual([{ ...job("a"), status: "running" }, { ...job("b"), status: "queued" }]);
    first.resolve("first");
    expect(await a).toBe("first");
    expect(await b).toBe("second");
    await queue.idle();
    expect(order).toEqual(["a", "b"]);
    expect(queue.snapshot).toEqual([]);
  });

  it("cancels queued work promptly without starting it", async () => {
    const queue = new AIJobQueue();
    const first = deferred<void>();
    const a = queue.enqueue(job("a"), () => first.promise);
    const task = vi.fn(async () => "must not run");
    const b = queue.enqueue(job("b"), task);
    const cancelled = expect(b).rejects.toMatchObject({ name: "AbortError" });
    expect(queue.cancel("b")).toBe(true);
    await cancelled;
    expect(task).not.toHaveBeenCalled();
    expect(queue.cancel("missing")).toBe(false);
    first.resolve();
    await a;
    await queue.idle();
  });

  it("rejects active cancellation promptly but holds the slot and idle until native work settles", async () => {
    const queue = new AIJobQueue();
    const native = deferred<string>();
    let signal: AbortSignal | undefined;
    const a = queue.enqueue(job("a"), s => { signal = s; return native.promise; });
    const next = vi.fn(async () => "next");
    const b = queue.enqueue(job("b"), next);
    const cancellation = expect(a).rejects.toMatchObject({ name: "AbortError" });
    let idle = false;
    const idlePromise = queue.idle().then(() => { idle = true; });
    await turn();
    queue.cancel("a");
    await cancellation;
    expect(signal?.aborted).toBe(true);
    await turn();
    expect(next).not.toHaveBeenCalled();
    expect(idle).toBe(false);
    expect(queue.snapshot[0]).toMatchObject({ id: "a", status: "running" });
    await expect(queue.enqueue(job("a"), async () => "duplicate")).rejects.toThrow("already exists");
    native.resolve("late native result");
    expect(await b).toBe("next");
    await idlePromise;
    expect(idle).toBe(true);
  });

  it("cancels an owner's jobs while allowing another Meeting to finish", async () => {
    const queue = new AIJobQueue();
    const native = deferred<void>();
    const a = queue.enqueue(job("a"), () => native.promise);
    const b = queue.enqueue(job("b"), async () => "cancelled");
    const c = queue.enqueue(job("c", "meeting:2"), async () => "kept");
    const cancelled = Promise.all([expect(a).rejects.toMatchObject({ name: "AbortError" }), expect(b).rejects.toMatchObject({ name: "AbortError" })]);
    await turn();
    expect(queue.cancelOwner("meeting:1")).toBe(2);
    await cancelled;
    native.resolve();
    expect(await c).toBe("kept");
    await queue.idle();
  });

  it("shutdown aborts jobs and waits for engine exit before declaring the queue idle", async () => {
    const queue = new AIJobQueue();
    const native = deferred<void>();
    const a = queue.enqueue(job("a"), () => native.promise);
    const queued = vi.fn(async () => "not run");
    const b = queue.enqueue(job("b"), queued);
    const cancellation = Promise.all([expect(a).rejects.toMatchObject({ name: "AbortError" }), expect(b).rejects.toMatchObject({ name: "AbortError" })]);
    await turn();
    let stopped = false;
    const stopping = queue.shutdown().then(() => { stopped = true; });
    await cancellation;
    await expect(queue.enqueue(job("c"), async () => "closed")).rejects.toThrow("shutting down");
    await turn();
    expect(stopped).toBe(false);
    native.reject(new Error("engine exited"));
    await stopping;
    expect(queued).not.toHaveBeenCalled();
    expect(queue.snapshot).toEqual([]);
  });

  it("isolates observer failures, supports unsubscribe and protects metadata snapshots", async () => {
    const queue = new AIJobQueue();
    queue.onChange(() => { throw new Error("broken window"); });
    const observer = vi.fn();
    const unsubscribe = queue.onChange(observer);
    const first = deferred<string>();
    const metadata = job("a");
    const a = queue.enqueue(metadata, () => first.promise);
    metadata.owner = "changed";
    const state = queue.snapshot;
    state[0]!.owner = "also changed";
    expect(queue.snapshot[0]?.owner).toBe("meeting:1");
    expect(observer).toHaveBeenCalled();
    const count = observer.mock.calls.length;
    unsubscribe();
    first.resolve("done");
    expect(await a).toBe("done");
    await queue.idle();
    expect(observer).toHaveBeenCalledTimes(count);
  });

  it("releases failed work and handles rejection with an undefined reason", async () => {
    const queue = new AIJobQueue();
    const failure = queue.enqueue(job("a"), async () => { throw undefined; });
    const rejected = await failure.then(() => false, reason => reason === undefined);
    expect(rejected).toBe(true);
    expect(await queue.enqueue(job("b"), async () => 42)).toBe(42);
    await queue.idle();
  });

  it("does not invoke a job cancelled before its first turn", async () => {
    const queue = new AIJobQueue();
    const task = vi.fn(async () => "not run");
    const work = queue.enqueue(job("a"), task);
    const cancelled = expect(work).rejects.toMatchObject({ name: "AbortError" });
    queue.cancel("a");
    await cancelled;
    await queue.idle();
    expect(task).not.toHaveBeenCalled();
  });

  it("allows cancellation from an observer without recursive notifications", async () => {
    const queue = new AIJobQueue();
    queue.onChange(() => { queue.cancel("a"); });
    const task = vi.fn(async () => "not run");
    const work = queue.enqueue(job("a"), task);
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    await queue.idle();
    expect(task).not.toHaveBeenCalled();
  });
});
