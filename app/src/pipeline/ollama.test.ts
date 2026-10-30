import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkOllama, listOllamaModels, OllamaClient } from "./ollama.js";
import { AI_SETTINGS, assertRequestBudget, requestBytes } from "./model-request.js";
import type { TextRequest } from "./language-model.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const request: TextRequest = {
  messages: [{ role: "system", content: "Use only the supplied Transcript." }, { role: "user", content: "[0] You: Friday is only a proposal." }],
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};
const reply = { message: { role: "assistant", content: '{"text":"Friday was proposed."}' }, done: true,
  done_reason: "stop", prompt_eval_count: 64, eval_count: 12, load_duration: 12345 };

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const data of request) body += String(data);
  return JSON.parse(body);
}

describe("local Ollama model interface", () => {
  it("sends separated messages and bounded generation settings and returns operational metadata", async () => {
    let received: unknown;
    const baseUrl = await serve((req, res) => {
      void jsonBody(req).then(body => { received = body; res.end(JSON.stringify(reply)); });
    });
    const response = await new OllamaClient({ baseUrl, model: "local:test" }).complete(request);
    expect(received).toEqual({ model: "local:test", messages: request.messages, stream: false, format: request.schema, think: false,
      options: { num_ctx: 8192, num_predict: 2048, temperature: 0 } });
    expect(response.text).toBe(reply.message.content);
    expect(response.metadata).toMatchObject({ model: "local:test", promptTokens: 64, outputTokens: 12, loadDurationNs: 12345 });
    expect(response.metadata.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(response.metadata)).not.toContain("Friday");
  });

  it("asks for the model as it is at each request, so a change applies to the next one", async () => {
    const asked: string[] = [];
    const baseUrl = await serve((req, res) => {
      void jsonBody(req).then(body => { asked.push((body as { model: string }).model); res.end(JSON.stringify(reply)); });
    });
    let chosen = "first:1b";
    const client = new OllamaClient({ baseUrl, model: () => chosen });
    await client.complete(request);
    chosen = "second:2b";
    const second = await client.complete(request);
    expect(asked).toEqual(["first:1b", "second:2b"]);
    expect(second.metadata.model).toBe("second:2b");
  });

  it("preserves the prompt-in/string-out compatibility adapter", async () => {
    let received: { messages?: unknown } = {};
    const baseUrl = await serve((req, res) => {
      void jsonBody(req).then(body => { received = body as typeof received; res.end(JSON.stringify(reply)); });
    });
    const output = await new OllamaClient({ baseUrl }).generate({ prompt: "A synthetic Transcript", schema: request.schema });
    expect(output).toBe(reply.message.content);
    expect(received.messages).toEqual([{ role: "user", content: "A synthetic Transcript" }]);
  });

  it("honors a smaller output budget and explicit request timeout", async () => {
    let options: unknown;
    const baseUrl = await serve((req, res) => {
      void jsonBody(req).then(body => { options = (body as { options: unknown }).options; res.end(JSON.stringify(reply)); });
    });
    await new OllamaClient({ baseUrl }).complete({ ...request, maxOutputTokens: 100, timeoutMs: 1000 });
    expect(options).toMatchObject({ num_predict: 100 });
  });

  it("refuses oversized complete requests before any connection, including the legacy adapter", async () => {
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(client.complete({ ...request, messages: [...request.messages, { role: "assistant", content: "x".repeat(6000) }] })).rejects.toThrow("input budget");
    await expect(client.generate({ prompt: "x".repeat(6000), schema: {} })).rejects.toThrow("input budget");
  });

  it("rejects non-local endpoints and oversized output budgets", async () => {
    expect(() => new OllamaClient({ baseUrl: "https://example.com" })).toThrow("local loopback");
    expect(() => new OllamaClient({ baseUrl: "http://user:pass@localhost:11434" })).toThrow("local loopback");
    await expect(new OllamaClient().complete({ ...request, maxOutputTokens: 2049 })).rejects.toThrow("response budget");
  });

  it("never follows redirects that could send content away from the local server", async () => {
    let calls = 0;
    const baseUrl = await serve((_req, res) => { calls++; res.writeHead(307, { location: "https://example.com" }); res.end(); });
    await expect(new OllamaClient({ baseUrl }).complete(request)).rejects.toThrow("Start it and retry");
    expect(calls).toBe(1);
  });

  it("returns actionable missing-model and connection errors without retries or server content", async () => {
    let calls = 0;
    const baseUrl = await serve((_req, res) => { calls++; res.writeHead(404); res.end("PRIVATE TRANSCRIPT ECHO"); });
    const client = new OllamaClient({ baseUrl, model: "local:missing" });
    await expect(client.complete(request)).rejects.toThrow("ollama pull local:missing");
    expect(calls).toBe(1);
    const stopped = new OllamaClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(stopped.complete(request)).rejects.toThrow("Ollama is not running");
  });

  it("does not put an error response body into application errors", async () => {
    const baseUrl = await serve((_req, res) => { res.writeHead(500); res.end("PRIVATE TRANSCRIPT ECHO"); });
    await expect(new OllamaClient({ baseUrl }).complete(request)).rejects.toThrow(/^Ollama returned HTTP 500/);
  });

  it("cancels a request whose response headers arrived but whose body is still pending", async () => {
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const baseUrl = await serve((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"message":'); entered(); });
    const controller = new AbortController();
    const result = new OllamaClient({ baseUrl }).complete({ ...request, signal: controller.signal });
    await entering;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError", message: "AI request was cancelled" });
  });

  it("times out while reading the response body rather than leaving generation active", async () => {
    const baseUrl = await serve((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"message":'); });
    await expect(new OllamaClient({ baseUrl, timeoutMs: 100 }).complete(request)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("does not contact Ollama for a pre-cancelled request", async () => {
    let calls = 0;
    const baseUrl = await serve((_req, res) => { calls++; res.end(JSON.stringify(reply)); });
    const controller = new AbortController();
    controller.abort();
    await expect(new OllamaClient({ baseUrl }).complete({ ...request, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });

  it("rejects malformed, missing, incomplete and truncated replies", async () => {
    const replies = ["not JSON", JSON.stringify({}), JSON.stringify({ ...reply, message: {} }),
      JSON.stringify({ ...reply, done: false }), JSON.stringify({ ...reply, done_reason: "length" })];
    const baseUrl = await serve((_req, res) => res.end(replies.shift()));
    const client = new OllamaClient({ baseUrl });
    for (let index = 0; index < 5; index++) await expect(client.complete(request)).rejects.toThrow(/Ollama/);
  });

  it("bounds the HTTP body and refuses a token count that uses the reserved output room", async () => {
    const responses = ["x".repeat(129 * 1024), JSON.stringify({ ...reply, prompt_eval_count: 8000 })];
    const baseUrl = await serve((_req, res) => res.end(responses.shift()));
    const client = new OllamaClient({ baseUrl });
    await expect(client.complete(request)).rejects.toThrow("response size limit");
    await expect(client.complete(request)).rejects.toThrow("insufficient response room");
  });
});

describe("complete request accounting", () => {
  it("counts UTF-8 bytes including schema, history, roles and JSON escaping", () => {
    const value = { messages: [...request.messages, { role: "assistant" as const, content: 'Café\\n"quoted"' }], schema: request.schema };
    expect(requestBytes(value)).toBe(Buffer.byteLength(JSON.stringify(value), "utf8"));
    expect(requestBytes(value)).toBeGreaterThan(JSON.stringify(value).length);
    expect(() => assertRequestBudget(value, requestBytes(value))).not.toThrow();
    expect(() => assertRequestBudget(value, requestBytes(value) - 1)).toThrow("input budget");
    expect(AI_SETTINGS.maxInputBytes).toBe(5500);
  });
});

describe("the models pulled into Ollama", () => {
  const tags = (names: string[]) => (_req: IncomingMessage, res: ServerResponse) => { res.end(JSON.stringify({ models: names.map(name => ({ name })) })); };

  it("lists them sorted, and nothing when Ollama is not running", async () => {
    const baseUrl = await serve(tags(["qwen3:4b", "gemma3:4b", "llama3.2:3b"]));
    expect(await listOllamaModels({ baseUrl })).toEqual(["gemma3:4b", "llama3.2:3b", "qwen3:4b"]);
    expect(await listOllamaModels({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 })).toEqual([]);
  });

  it("checks readiness for the model it is given", async () => {
    const baseUrl = await serve(tags(["gemma3:4b", "llama3.2:3b"]));
    expect(await checkOllama({ baseUrl, model: "llama3.2:3b" })).toEqual({ status: "ready" });
    expect(await checkOllama({ baseUrl, model: "qwen3:4b" })).toMatchObject({ status: "no-model", message: expect.stringContaining("ollama pull qwen3:4b") });
  });
});
