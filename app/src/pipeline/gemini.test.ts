import { expect, it, vi } from "vitest";
import { GeminiClient, GEMINI_INPUT_BYTES, listGeminiModels, quotaMessage } from "./gemini.js";
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

const model = (name: string, methods = ["generateContent", "countTokens"], displayName = name) => ({ name: `models/${name}`, displayName, supportedGenerationMethods: methods });
const list = (models: unknown[], nextPageToken?: string) => new Response(JSON.stringify({ models, ...(nextPageToken ? { nextPageToken } : {}) }));

it("lists the text models the key can use, sorted, leaving out other kinds of model", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => list([
    model("gemini-2.5-pro", undefined, "Gemini 2.5 Pro"),
    model("gemini-2.5-flash", undefined, "Gemini 2.5 Flash"),
    model("gemini-2.5-flash-image"),
    model("gemini-2.5-flash-preview-tts"),
    model("gemini-live-2.5-flash-preview"),
    model("gemini-embedding-001", ["embedContent"]),
    model("gemini-2.0-flash-lite", ["countTokens"]),
    model("imagen-4.0-generate-001", ["predict"]),
    model("gemma-3-27b-it"),
    { name: "gemini-no-prefix", supportedGenerationMethods: ["generateContent"] },
  ]));
  expect(await listGeminiModels({ apiKey: "private-key", fetch: fetcher })).toEqual([
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ]);
});

it("asks Google's fixed endpoint with the key in a header only, and follows pages", async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(list([model("gemini-a")], "next-page"))
    .mockResolvedValueOnce(list([model("gemini-b")]));
  const result = await listGeminiModels({ apiKey: "private-key", fetch: fetcher });
  expect(result.map(m => m.id)).toEqual(["gemini-a", "gemini-b"]);
  const [first, init] = fetcher.mock.calls[0]!;
  expect(String(first)).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
  expect(String(first)).not.toContain("private-key");
  expect(init?.redirect).toBe("error");
  expect(init?.headers).toMatchObject({ "x-goog-api-key": "private-key" });
  expect(String(fetcher.mock.calls[1]![0])).toContain("pageToken=next-page");
});

it.each([401, 403, 429, 500])("sanitizes HTTP %s from the model list without echoing the key or the server's reply", async status => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response("private-key and server details", { status }));
  await expect(listGeminiModels({ apiKey: "private-key", fetch: fetcher })).rejects.toThrow(/Gemini/);
  try { await listGeminiModels({ apiKey: "private-key", fetch: fetcher }); } catch (error) {
    expect(String(error)).not.toContain("private-key");
    expect(String(error)).not.toContain("server details");
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("rejects a malformed model list, a bad key and an unreachable server without leaking the cause", async () => {
  await expect(listGeminiModels({ apiKey: "private-key", fetch: async () => new Response("not json") })).rejects.toThrow("invalid model list");
  await expect(listGeminiModels({ apiKey: "private-key", fetch: async () => new Response("{}") })).rejects.toThrow("no model list");
  await expect(listGeminiModels({ apiKey: "has space" })).rejects.toThrow("valid Gemini API key");
  await expect(listGeminiModels({ apiKey: "private-key", fetch: async () => { throw new Error("socket private-key"); } })).rejects.toThrow("Could not reach Gemini");
});

it("can be cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(listGeminiModels({ apiKey: "private-key", signal: controller.signal, fetch: async () => list([]) })).rejects.toMatchObject({ name: "AbortError" });
});

/** The shape of Google's 429: a free-text message plus structured quota and retry details. */
const quotaBody = (extra: { limit?: number; message?: string } = {}) => JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED",
  message: extra.message ?? `You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: ${extra.limit ?? 20}, model: gemini-4-argon\nPlease retry in 28.5s.`,
  details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaDimensions: { location: "global", model: "gemini-4-argon" } }] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "28s" },
  ] } });

it("names the quota, the model and the retry delay when Google refuses for quota", () => {
  expect(quotaMessage(quotaBody())).toBe("Gemini quota or rate limit reached for gemini-4-argon (GenerateRequestsPerDayPerProjectPerModel-FreeTier). Retry in 28s.");
});

it("says the model is not on the plan when its limit is zero", () => {
  expect(quotaMessage(quotaBody({ limit: 0 }))).toContain("This model has no quota on your plan: choose another model, or enable billing");
});

it("never forwards Google's free text, only tokens that pass a strict pattern", () => {
  const hostile = quotaMessage(quotaBody({ message: "Synthetic evidence and private-key, limit: 5" }).replace("gemini-4-argon", "bad model <script>"), "gemini-test");
  expect(hostile).not.toContain("Synthetic evidence");
  expect(hostile).not.toContain("private-key");
  expect(hostile).not.toContain("<script>");
  expect(hostile).toContain("for gemini-test");
});

it("falls back to the general message for a 429 that is not structured", () => {
  expect(quotaMessage("rate limited", "gemini-test")).toBe("Gemini quota or rate limit reached for gemini-test. Check your Google account usage and retry later.");
  expect(quotaMessage("")).toBe("Gemini quota or rate limit reached. Check your Google account usage and retry later.");
});

it("reports the quota detail through a real 429 from generation and from the model list, without the key or the reply text", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(quotaBody({ message: "private-key Synthetic evidence limit: 0" }), { status: 429 }));
  const generation = new GeminiClient({ apiKey: "private-key", model: "gemini-test", fetch: fetcher }).complete(request);
  await expect(generation).rejects.toThrow("for gemini-4-argon (GenerateRequestsPerDayPerProjectPerModel-FreeTier)");
  await expect(generation).rejects.toThrow("no quota on your plan");
  const listing = listGeminiModels({ apiKey: "private-key", fetch: fetcher });
  await expect(listing).rejects.toThrow("Gemini quota or rate limit reached");
  for (const attempt of [generation, listing]) await attempt.catch(error => {
    expect(String(error)).not.toContain("private-key");
    expect(String(error)).not.toContain("Synthetic evidence");
  });
});
