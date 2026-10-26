import type { SourceFragment } from "./evidence.js";
import type { Transcript } from "./pipeline.js";

export interface EvidencePassage {
  id: number;
  meetingId: number;
  revision: string;
  index: number;
  sources: SourceFragment[];
  text: string;
}

/** Original text, word-aligned where possible. A long word is split on Unicode character boundaries. */
function fragments(text: string): string[] {
  const result: string[] = [];
  let rest = text;
  while (Buffer.byteLength(rest, "utf8") > 1000) {
    let prefix = "";
    let bytes = 0;
    for (const character of rest) {
      const cost = Buffer.byteLength(character, "utf8");
      if (bytes + cost > 1000) break;
      prefix += character;
      bytes += cost;
    }
    const whitespace = [...prefix.matchAll(/\s/gu)].at(-1);
    if (whitespace && whitespace.index > 0) prefix = prefix.slice(0, whitespace.index + whitespace[0].length);
    result.push(prefix);
    rest = rest.slice(prefix.length);
  }
  result.push(rest);
  return result;
}

/** Derived passages preserve every source character and stable ordinal:fragment identities. */
export function buildPassages(transcript: Transcript): Pick<EvidencePassage, "index" | "sources" | "text">[] {
  const sources = transcript.segments.flatMap((segment, ref) =>
    fragments(segment.text).map((text, part): SourceFragment => ({
      id: `${ref}:${part}`, ref, part, speaker: segment.speaker, start: segment.start, end: segment.end, text,
    })));
  const passages: Pick<EvidencePassage, "index" | "sources" | "text">[] = [];
  let current: SourceFragment[] = [];
  let length = 0;
  function flush() {
    if (!current.length) return;
    passages.push({ index: passages.length, sources: current, text: current.map(source => source.text).join("\n") });
    current = [];
    length = 0;
  }
  for (const source of sources) {
    const cost = source.text.length + (current.length ? 1 : 0);
    if (current.length && length + cost > 1500) flush();
    current.push(source);
    length += source.text.length + (current.length > 1 ? 1 : 0);
  }
  flush();
  return passages;
}
