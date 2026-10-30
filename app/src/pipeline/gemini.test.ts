import { expect, it, vi } from "vitest";
import { GeminiClient, GEMINI_INPUT_BYTES } from "./gemini.js";
import type { TextRequest } from "./language-model.js";

const request: TextRequest = { messages: [{ role: "system", content: "Rules" }, { role: "user", content: "Synthetic evidence" }], schema: { type: "object" } };
const reply = (extra = {}) => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"ok":true}' }] } }], modelVersion: "gemini-test-001", usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 }, ...extra }));

it("uses Google's fixed endpoint, header credentials and JSON schema without changing local budgets", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => reply());
  const client = new GeminiClient({ apiKey: "private-key", model: "gemini-test", fetch: fetcher });
  const result = await client.complete(request);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
  expect(init?.redirect).toBe("error");
  expect(init?.headers).toMatchObject({ "x-goog-api-key": "private-key" });
  expect(JSON.parse(String(init?.body))).toMatchObject({ systemInstruction: { parts: [{ text: "Rules" }] }, generationConfig: { responseMimeType: "application/json", responseJsonSchema: request.schema } });
  expect(result).toMatchObject({ text: '{"ok":true}', metadata: { model: "gemini-test-001", promptTokens: 50, outputTokens: 5 } });
});

it.each([400, 401, 403, 404, 429, 500])("sanitizes HTTP %s without retrying or echoing server speech or keys", async status => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response("private-key Synthetic evidence", { status }));
  const client = new GeminiClient({ apiKey: "private-key", fetch: fetcher });
  try { await client.complete(request); expect.unreachable(); } catch (error) {
    expect(String(error)).not.toContain("private-key");
    expect(String(error)).not.toContain("Synthetic evidence");
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects truncated, blocked, oversized and malformed responses", async () => {
  for (const response of [reply({ candidates: [{ finishReason: "MAX_TOKENS" }] }), reply({ promptFeedback: { blockReason: "SAFETY" }, candidates: [] }), new Response("{"), new Response("x".repeat(513 * 1024))]) {
    const client = new GeminiClient({ apiKey: "private-key", fetch: async () => response });
    await expect(client.complete(request)).rejects.toThrow(/Gemini/);
  }
});

it("bounds complete requests and refuses injected model paths before contacting a server", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => reply());
  expect(() => new GeminiClient({ apiKey: "private-key", model: "../leak", fetch: fetcher })).toThrow("model name");
  const client = new GeminiClient({ apiKey: "private-key", fetch: fetcher });
  await expect(client.complete({ ...request, messages: [{ role: "user", content: "x".repeat(GEMINI_INPUT_BYTES) }] })).rejects.toThrow("budget");
  expect(fetcher).not.toHaveBeenCalled();
});

it("propagates cancellation and timeouts without returning partial content", async () => {
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("private-key")), { once: true });
  });
  const client = new GeminiClient({ apiKey: "private-key", fetch: fetcher });
  const controller = new AbortController();
  const work = client.complete({ ...request, signal: controller.signal });
  controller.abort();
  await expect(work).rejects.toMatchObject({ name: "AbortError" });
  await expect(client.complete({ ...request, timeoutMs: 10 })).rejects.toMatchObject({ name: "TimeoutError" });
  await expect(client.complete({ ...request, signal: AbortSignal.timeout(10) })).rejects.toMatchObject({ name: "TimeoutError" });
});
