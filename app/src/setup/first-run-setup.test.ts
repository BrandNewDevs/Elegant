import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkOllama, type OllamaStatus } from "../pipeline/ollama.js";
import { openStore } from "../store/store.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { FirstRunSetup } from "./first-run-setup.js";

function setup(ollama: OllamaStatus = { status: "ready" }) {
  const engine = new FakeEngine();
  const store = openStore(":memory:");
  const first = new FirstRunSetup(engine, store, {
    speechModel: "tiny",
    modelsDirectory: "/models",
    checkOllama: async () => ollama,
  });
  return { engine, store, first };
}

describe("permissions", () => {
  it("asks macOS only when the user asks, and marks the step done once it is granted", () => {
    const { engine, first } = setup();
    expect(engine.commands).toEqual([]);

    first.requestMicrophone();
    expect(engine.commands).toEqual([{ type: "request_permission", permission: "microphone" }]);
    expect(first.state.microphone.status).toBe("working");

    engine.emit({ type: "permission_result", permission: "microphone", granted: true });
    expect(first.state.microphone.status).toBe("done");
    expect(first.state.systemAudio.status).toBe("todo");

    first.requestSystemAudio();
    expect(engine.commands.at(-1)).toEqual({ type: "request_permission", permission: "system_audio" });
    engine.emit({ type: "permission_result", permission: "system_audio", granted: true });
    expect(first.state.systemAudio.status).toBe("done");
  });

  it("explains where to allow a permission that was denied, and lets the user try again", () => {
    const { engine, first } = setup();
    first.requestMicrophone();
    engine.emit({ type: "permission_result", permission: "microphone", granted: false });
    expect(first.state.microphone).toMatchObject({ status: "problem", message: expect.stringContaining("System Settings") });

    first.requestMicrophone();
    expect(first.state.microphone.status).toBe("working");
  });

  it("does not send the same request twice while one is waiting for an answer", () => {
    const { engine, first } = setup();
    first.requestMicrophone();
    first.requestMicrophone();
    expect(engine.commands).toHaveLength(1);
  });
});

describe("models", () => {
  it("shows download progress, then done", () => {
    const { engine, first } = setup();
    const seen: number[] = [];
    first.onChange(() => seen.push(first.state.models.fraction));

    first.downloadModels();
    expect(engine.commands).toEqual([{ type: "download_models", model: "tiny", modelsDirectory: "/models" }]);
    engine.emit({ type: "model_download_progress", model: "tiny", fraction: 0.4 });
    expect(first.state.models).toEqual({ status: "working", fraction: 0.4 });

    engine.emit({ type: "models_ready" });
    expect(first.state.models).toEqual({ status: "done", fraction: 1 });
    expect(seen).toEqual([0, 0.4, 1]);
  });

  it("says why a download failed and can be retried", () => {
    const { engine, first } = setup();
    first.downloadModels();
    engine.emit({ type: "model_download_failed", message: "offline" });
    expect(first.state.models).toMatchObject({ status: "problem", message: expect.stringContaining("offline") });

    first.downloadModels();
    expect(first.state.models.status).toBe("working");
  });

  it("fails a step that is waiting when the engine stops", () => {
    const { engine, first } = setup();
    first.downloadModels();
    first.requestMicrophone();
    engine.exit();
    expect(first.state.models.status).toBe("problem");
    expect(first.state.microphone.status).toBe("problem");
    expect(first.state.systemAudio.status).toBe("todo");
  });
});

describe("finishing", () => {
  function allDone({ engine, first }: ReturnType<typeof setup>) {
    first.requestMicrophone();
    engine.emit({ type: "permission_result", permission: "microphone", granted: true });
    first.requestSystemAudio();
    engine.emit({ type: "permission_result", permission: "system_audio", granted: true });
    first.downloadModels();
    engine.emit({ type: "models_ready" });
  }

  it("is complete once both permissions are granted and the models are downloaded, and stays complete next launch", () => {
    const ctx = setup();
    expect(ctx.first.complete).toBe(false);
    allDone(ctx);
    expect(ctx.first.complete).toBe(true);

    const nextLaunch = new FirstRunSetup(new FakeEngine(), ctx.store, { speechModel: "tiny", modelsDirectory: "/models", checkOllama: async () => ({ status: "ready" }) });
    expect(nextLaunch.complete).toBe(true);
  });

  it("is not complete while a permission or the models are missing", () => {
    const ctx = setup();
    ctx.first.requestMicrophone();
    ctx.engine.emit({ type: "permission_result", permission: "microphone", granted: true });
    ctx.first.downloadModels();
    ctx.engine.emit({ type: "models_ready" });
    expect(ctx.first.complete).toBe(false);
  });

  it("is complete even though Ollama is not running, since recording does not need it", async () => {
    const ctx = setup({ status: "not-running", message: "Ollama is not running" });
    await ctx.first.checkOllama();
    allDone(ctx);
    expect(ctx.first.complete).toBe(true);
    expect(ctx.first.state.ollama).toEqual({ status: "problem", message: "Ollama is not running" });
  });
});

describe("the Ollama check", () => {
  it("reports done when Ollama has the model, and the message when it does not", async () => {
    const ready = setup();
    await ready.first.checkOllama();
    expect(ready.first.state.ollama.status).toBe("done");

    const noModel = setup({ status: "no-model", message: "Run: ollama pull gemma3:4b" });
    await noModel.first.checkOllama();
    expect(noModel.first.state.ollama).toEqual({ status: "problem", message: "Run: ollama pull gemma3:4b" });
  });
});

describe("checkOllama against an HTTP server", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function ollamaWith(models: string[]): Promise<string> {
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(req.url === "/api/tags" ? JSON.stringify({ models: models.map((name) => ({ name })) }) : "{}");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("is ready when the model is pulled", async () => {
    const baseUrl = await ollamaWith(["llama3:8b", "gemma3:4b"]);
    expect(await checkOllama({ baseUrl, model: "gemma3:4b" })).toEqual({ status: "ready" });
  });

  it("says to pull the model when Ollama has none, or only other ones", async () => {
    const baseUrl = await ollamaWith(["llama3:8b"]);
    expect(await checkOllama({ baseUrl, model: "gemma3:4b" })).toMatchObject({ status: "no-model", message: expect.stringContaining("ollama pull gemma3:4b") });
  });

  it("says Ollama is not running when nothing answers", async () => {
    const baseUrl = await ollamaWith([]);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    expect(await checkOllama({ baseUrl })).toMatchObject({ status: "not-running", message: expect.stringContaining("not running") });
  });
});
