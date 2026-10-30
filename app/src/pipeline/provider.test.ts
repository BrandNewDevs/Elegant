import { expect, it, vi } from "vitest";
import { createProviderRouting } from "./provider.js";
import type { AISelection } from "../setup/ai-settings.js";
import type { MeetingChatGenerator } from "./meeting-chat.js";

const transcript = { segments: [{ start: 0, end: 1, speaker: "You", text: "Synthetic meeting" }] };
const summary = { tldr: "Existing result", participants: [{ speaker: "You", said: ["Existing point"] }] };
const chat: MeetingChatGenerator = async () => ({ answer: { text: "Original quotation", refs: [0], sufficient: true }, revision: "revision",
  generation: { model: "local-model", promptVersion: "unchanged", calls: 1, elapsedMs: 1, retrievalCalls: 0, retrievalMode: "full", exhaustive: true } });

it("delegates the default directly to existing Ollama functions, with no Gemini factory calls", async () => {
  const local = { summarise: vi.fn(async () => summary), chat: vi.fn(chat) };
  const gemini = vi.fn(() => local);
  const router = createProviderRouting({ snapshot: async () => ({ provider: "ollama" }), local, gemini });
  expect(await router.summarise(transcript)).toEqual(summary);
  await router.chat({ meetingId: 1, question: "Question", history: [], expectedRevision: "revision" });
  expect(local.summarise).toHaveBeenCalledWith(transcript, undefined);
  expect(local.chat).toHaveBeenCalledTimes(1);
  expect(gemini).not.toHaveBeenCalled();
});

it("holds one provider and model through an operation and uses the new selection on the next operation", async () => {
  let selection: AISelection = { provider: "gemini", model: "gemini-test", apiKey: "key" };
  let release: () => void = () => {};
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const local = { summarise: vi.fn(async () => summary), chat };
  const gemini = vi.fn((_selection: Extract<AISelection, { provider: "gemini" }>) => ({ summarise: vi.fn(async () => { await barrier; return summary; }), chat }));
  const snapshot = vi.fn(async () => selection);
  const router = createProviderRouting({ snapshot, local, gemini });
  const work = router.summarise(transcript);
  await vi.waitFor(() => expect(gemini).toHaveBeenCalledTimes(1));
  selection = { provider: "ollama" }; release();
  await work;
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(gemini.mock.calls[0]![0]).toMatchObject({ model: "gemini-test" });
  await router.summarise(transcript);
  expect(local.summarise).toHaveBeenCalledTimes(1);
});

it("never falls back after either provider fails", async () => {
  const local = { summarise: vi.fn(async () => { throw new Error("Ollama stopped"); }), chat };
  const gemini = vi.fn(() => ({ summarise: async () => { throw new Error("Gemini quota"); }, chat }));
  let selection: AISelection = { provider: "ollama" };
  const router = createProviderRouting({ snapshot: async () => selection, local, gemini });
  await expect(router.summarise(transcript)).rejects.toThrow("Ollama stopped");
  expect(gemini).not.toHaveBeenCalled();
  selection = { provider: "gemini", model: "gemini-test", apiKey: "key" };
  await expect(router.summarise(transcript)).rejects.toThrow("Gemini quota");
  expect(local.summarise).toHaveBeenCalledTimes(1);
});
