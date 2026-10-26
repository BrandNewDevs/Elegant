import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkOllama, type OllamaStatus } from "../pipeline/ollama.js";
import { openStore } from "../store/store.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { Setup } from "./setup.js";

function options(ollama: OllamaStatus = { status: "ready" }) {
  return { speechModel: "tiny", modelsDirectory: "/models", checkOllama: async () => ollama };
}

function setup(ollama: OllamaStatus = { status: "ready" }, store = openStore(":memory:")) {
  const engine = new FakeEngine();
  const s = new Setup(engine, store, options(ollama));
  return { engine, store, s };
}

describe("permissions", () => {
  it("asks macOS only when the user asks, and marks the step done once it is granted", () => {
    const { engine, s } = setup();
    expect(engine.commands).toEqual([]);

    s.requestMicrophone();
    expect(engine.commands).toEqual([{ type: "request_permission", permission: "microphone" }]);
    expect(s.state.microphone.status).toBe("working");

    engine.emit({ type: "permission_result", permission: "microphone", granted: true });
    expect(s.state.microphone.status).toBe("done");
    expect(s.state.systemAudio.status).toBe("todo");

    s.requestSystemAudio();
    expect(engine.commands.at(-1)).toEqual({ type: "request_permission", permission: "system_audio" });
    engine.emit({ type: "permission_result", permission: "system_audio", granted: true });
    expect(s.state.systemAudio.status).toBe("done");
  });

  it("explains where to allow a permission that was denied, and lets the user try again", () => {
    const { engine, s } = setup();
    s.requestMicrophone();
    engine.emit({ type: "permission_result", permission: "microphone", granted: false });
    expect(s.state.microphone).toMatchObject({ status: "problem", message: expect.stringContaining("System Settings") });

    s.requestMicrophone();
    expect(s.state.microphone.status).toBe("working");
  });

  it("does not send the same request twice while one is waiting for an answer", () => {
    const { engine, s } = setup();
    s.requestMicrophone();
    s.requestMicrophone();
    expect(engine.commands).toHaveLength(1);
  });
});

describe("models", () => {
  it("shows download progress, then done", () => {
    const { engine, s } = setup();
    const seen: number[] = [];
    s.onChange(() => seen.push(s.state.models.fraction));

    s.downloadModels();
    expect(engine.commands).toEqual([{ type: "download_models", model: "tiny", modelsDirectory: "/models" }]);
    engine.emit({ type: "model_download_progress", model: "tiny", fraction: 0.4 });
    expect(s.state.models).toEqual({ status: "working", fraction: 0.4 });

    engine.emit({ type: "models_ready" });
    expect(s.state.models).toEqual({ status: "done", fraction: 1 });
    expect(seen).toEqual([0, 0.4, 1]);
  });

  it("says why a download failed and can be retried", () => {
    const { engine, s } = setup();
    s.downloadModels();
    engine.emit({ type: "model_download_failed", message: "offline" });
    expect(s.state.models).toMatchObject({ status: "problem", message: expect.stringContaining("offline") });

    s.downloadModels();
    expect(s.state.models.status).toBe("working");
  });

  it("fails a step that is waiting when the engine stops", () => {
    const { engine, s } = setup();
    s.downloadModels();
    s.requestMicrophone();
    engine.exit();
    expect(s.state.models.status).toBe("problem");
    expect(s.state.microphone.status).toBe("problem");
    expect(s.state.systemAudio.status).toBe("todo");
  });
});

describe("remembering permissions", () => {
  function grantBoth({ engine, s }: ReturnType<typeof setup>) {
    s.requestMicrophone();
    engine.emit({ type: "permission_result", permission: "microphone", granted: true });
    s.requestSystemAudio();
    engine.emit({ type: "permission_result", permission: "system_audio", granted: true });
  }

  it("needs onboarding until both permissions are granted", () => {
    const { engine, s } = setup();
    expect(s.permissionsGranted).toBe(false);
    s.requestMicrophone();
    engine.emit({ type: "permission_result", permission: "microphone", granted: true });
    expect(s.permissionsGranted).toBe(false);
    s.requestSystemAudio();
    engine.emit({ type: "permission_result", permission: "system_audio", granted: true });
    expect(s.permissionsGranted).toBe(true);
  });

  it("checks the microphone without a prompt when the engine starts, and skips system audio it never granted", () => {
    const { engine, s } = setup();
    engine.emit({ type: "ready", version: "1" });
    expect(engine.commands).toEqual([{ type: "check_permission", permission: "microphone" }]);
    expect(s.permissionsChecked).toBe(false);

    engine.emit({ type: "permission_result", permission: "microphone", granted: false });
    expect(s.permissionsChecked).toBe(true);
    expect(s.state.microphone.status).toBe("todo");
    expect(s.state.systemAudio.status).toBe("todo");
  });

  it("does not ask again for permissions granted on an earlier launch", () => {
    const first = setup();
    grantBoth(first);

    const { engine, s } = setup(undefined, first.store);
    expect(s.state.microphone.status).toBe("done");
    expect(s.state.systemAudio.status).toBe("done");
    engine.emit({ type: "ready", version: "1" });
    expect(engine.commands).toEqual([
      { type: "check_permission", permission: "microphone" },
      { type: "check_permission", permission: "system_audio" },
    ]);
    engine.emit({ type: "permission_result", permission: "microphone", granted: true });
    expect(s.permissionsChecked).toBe(false);
    engine.emit({ type: "permission_result", permission: "system_audio", granted: true });
    expect(s.permissionsChecked).toBe(true);
    expect(s.permissionsGranted).toBe(true);
    expect(engine.commands.some((c) => c.type === "request_permission")).toBe(false);
  });

  it("explains a permission that was granted before but is now turned off, and asks only for that one", () => {
    const first = setup();
    grantBoth(first);

    const { engine, s } = setup(undefined, first.store);
    engine.emit({ type: "ready", version: "1" });
    engine.emit({ type: "permission_result", permission: "microphone", granted: true });
    engine.emit({ type: "permission_result", permission: "system_audio", granted: false });
    expect(s.state.microphone.status).toBe("done");
    expect(s.state.systemAudio).toMatchObject({ status: "problem", message: expect.stringContaining("System Settings") });
    expect(s.permissionsGranted).toBe(false);

    // The loss is remembered: the next launch no longer trusts the old grant.
    const later = setup(undefined, first.store);
    expect(later.s.state.systemAudio.status).toBe("todo");
  });

  it("tells a listener once the remembered permissions have been checked", () => {
    const { engine, s } = setup();
    let calls = 0;
    s.onPermissionsChecked(() => calls++);
    engine.emit({ type: "ready", version: "1" });
    expect(calls).toBe(0);
    engine.emit({ type: "permission_result", permission: "microphone", granted: true });
    expect(calls).toBe(1);

    let late = 0;
    s.onPermissionsChecked(() => late++);
    expect(late).toBe(1);
  });

  it("stops waiting for the checks when the engine exits", () => {
    const { engine, s } = setup();
    engine.emit({ type: "ready", version: "1" });
    engine.exit();
    expect(s.permissionsChecked).toBe(true);
  });
});

describe("an upgrade from the earlier setup", () => {
  it("does not ask again for what the earlier setup finished, but still checks it", () => {
    const store = openStore(":memory:");
    store.setSetting("setupComplete", "true");
    const { engine, s } = setup(undefined, store);
    expect(s.state.microphone.status).toBe("done");
    expect(s.state.systemAudio.status).toBe("done");
    expect(s.state.models).toEqual({ status: "done", fraction: 1 });

    engine.emit({ type: "ready", version: "1" });
    expect(engine.commands).toHaveLength(2);
    engine.emit({ type: "permission_result", permission: "microphone", granted: true });
    engine.emit({ type: "permission_result", permission: "system_audio", granted: false });
    expect(s.state.systemAudio.status).toBe("problem");
    expect(setup(undefined, store).s.state.systemAudio.status).toBe("todo");
  });
});

describe("remembering the models", () => {
  it("shows them as downloaded on the next launch, even though Ollama is not running", async () => {
    const first = setup({ status: "not-running", message: "Ollama is not running" });
    first.s.downloadModels();
    first.engine.emit({ type: "models_ready" });

    const next = setup(undefined, first.store);
    expect(next.s.state.models).toEqual({ status: "done", fraction: 1 });
    expect(next.s.state.ollama.status).toBe("todo");
    await first.s.checkOllama();
    expect(first.s.state.ollama).toEqual({ status: "problem", message: "Ollama is not running" });
  });

  it("does not remember a failed download", () => {
    const first = setup();
    first.s.downloadModels();
    first.engine.emit({ type: "model_download_failed", message: "offline" });
    expect(setup(undefined, first.store).s.state.models.status).toBe("todo");
  });
});

describe("the Ollama check", () => {
  it("reports done when Ollama has the model, and the message when it does not", async () => {
    const ready = setup();
    await ready.s.checkOllama();
    expect(ready.s.state.ollama.status).toBe("done");

    const noModel = setup({ status: "no-model", message: "Run: ollama pull gemma3:4b" });
    await noModel.s.checkOllama();
    expect(noModel.s.state.ollama).toEqual({ status: "problem", message: "Run: ollama pull gemma3:4b" });
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
