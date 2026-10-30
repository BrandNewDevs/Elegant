import type { AISelection } from "../setup/ai-settings.js";
import type { PipelineStages } from "./pipeline.js";
import type { MeetingChatGenerator } from "./meeting-chat.js";

/** Snapshot once per operation, never once per model call. No provider fallback. */
export function createProviderRouting(options: {
  snapshot: () => Promise<AISelection>;
  local: { summarise: PipelineStages["summarise"]; chat: MeetingChatGenerator };
  gemini: (selection: Extract<AISelection, { provider: "gemini" }>) => { summarise: PipelineStages["summarise"]; chat: MeetingChatGenerator };
}) {
  const choose = async () => {
    const selection = await options.snapshot();
    return { provider: selection.provider, stages: selection.provider === "ollama" ? options.local : options.gemini(selection) };
  };
  const summarise: PipelineStages["summarise"] = async (transcript, context) => {
    context?.signal?.throwIfAborted();
    const { provider, stages } = await choose();
    context?.signal?.throwIfAborted();
    const result = await stages.summarise(transcript, context);
    return { ...result, ...(result.generation ? { generation: { ...result.generation, provider } } : {}) };
  };
  const chat: MeetingChatGenerator = async input => {
    input.signal?.throwIfAborted();
    const { provider, stages } = await choose();
    input.signal?.throwIfAborted();
    const result = await stages.chat(input);
    return { ...result, generation: { ...result.generation, provider } };
  };
  return { summarise, chat };
}
