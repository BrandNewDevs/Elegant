import type { LanguageModel } from "./language-model.js";
import type { Summary, Transcript, TranscriptSegment } from "./pipeline.js";
import { InvalidSummaryError, parseSummary, parseTldr, SUMMARY_SCHEMA, TLDR_SCHEMA } from "./validate-summary.js";

export interface SummariserOptions {
  model: LanguageModel;
  /** How many times to ask the model before giving up on output that fails validation. */
  attempts?: number;
  /** The most transcript text, in characters, sent to the model in one prompt. */
  maxChunkChars?: number;
}

// Sized for a 4B-class model with an 8k-token context: roughly 3k tokens of transcript, leaving room for the answer.
const DEFAULT_MAX_CHUNK_CHARS = 12_000;

const RULES = `Rules:
- Use the speaker labels exactly as written in the transcript. Never invent, guess or substitute names.
- Only include what is in the transcript. Do not add anything else.`;

const SUMMARISE_PROMPT = `You summarise a meeting transcript. Each line is "Speaker: what they said".
Reply with JSON: a "tldr" (two or three sentences on what was discussed and decided), and for each speaker a list "said" of the points that speaker made.
${RULES}
- "said" holds the points made, not a quote of everything.
- Leave out any speaker who made no point worth recording.`;

const COMBINE_PROMPT = `Below are summaries of consecutive parts of one long meeting. Reply with JSON holding a single "tldr": two or three sentences on what the whole meeting was about and decided.
${RULES}`;

const line = (s: TranscriptSegment) => `${s.speaker}: ${s.text}`;

/** Cuts a segment too long for the budget into word-aligned pieces by the same speaker, so no prompt overflows the context. */
function splitLong(s: TranscriptSegment, maxChars: number): TranscriptSegment[] {
  const room = maxChars - (line({ ...s, text: "" }).length + 1);
  if (s.text.length <= room || room < 1) return [s];
  const pieces: string[] = [];
  let current = "";
  for (const word of s.text.split(/\s+/)) {
    if (current !== "" && current.length + 1 + word.length > room) {
      pieces.push(current);
      current = word;
    } else {
      current = current === "" ? word : `${current} ${word}`;
    }
  }
  pieces.push(current);
  return pieces.map((text) => ({ ...s, text }));
}

/** Groups consecutive segments so each group's text fits the budget. */
function chunk(transcriptSegments: TranscriptSegment[], maxChars: number): TranscriptSegment[][] {
  const segments = transcriptSegments.flatMap((s) => splitLong(s, maxChars));
  const groups: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let size = 0;
  for (const s of segments) {
    const cost = line(s).length + 1;
    if (current.length > 0 && size + cost > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += cost;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Stage 2: a Transcript in, a Summary out, using a local language model. */
export function createSummariser({
  model,
  attempts = 3,
  maxChunkChars = DEFAULT_MAX_CHUNK_CHARS,
}: SummariserOptions): (transcript: Transcript) => Promise<Summary> {
  /** Asks the model, re-asking with the reason when its output fails `parse`. */
  async function ask<T>(prompt: string, schema: object, parse: (json: string) => T): Promise<T> {
    let problem: string | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const note = problem ? `\n\nYour previous answer was rejected because ${problem}. Fix that.` : "";
      try {
        return parse(await model.generate({ prompt: prompt + note, schema }));
      } catch (err) {
        if (!(err instanceof InvalidSummaryError)) throw err;
        problem = err.message;
      }
    }
    throw new InvalidSummaryError(`the model's output was rejected after ${attempts} attempts: ${problem}`);
  }

  async function summariseChunk(segments: TranscriptSegment[]): Promise<Summary> {
    const labels = new Set(segments.map((s) => s.speaker));
    const prompt = `${SUMMARISE_PROMPT}\n\nTranscript:\n${segments.map(line).join("\n")}`;
    return ask(prompt, SUMMARY_SCHEMA, (json) => parseSummary(json, labels));
  }

  return async (transcript) => {
    if (transcript.segments.length === 0) throw new Error("the Transcript is empty, so there is nothing to summarise");

    const parts: Summary[] = [];
    for (const segments of chunk(transcript.segments, maxChunkChars)) parts.push(await summariseChunk(segments));
    if (parts.length === 1) return parts[0]!;

    const said = new Map<string, string[]>();
    for (const part of parts) {
      for (const p of part.participants) said.set(p.speaker, [...(said.get(p.speaker) ?? []), ...p.said]);
    }
    const combinePrompt = `${COMBINE_PROMPT}\n\nSummaries:\n${parts.map((p, i) => `Part ${i + 1}: ${p.tldr}`).join("\n")}`;
    const tldr = await ask(combinePrompt, TLDR_SCHEMA, parseTldr);
    return { tldr, participants: [...said].map(([speaker, points]) => ({ speaker, said: points })) };
  };
}
