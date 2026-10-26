import type { SupportedFact } from "./grounded-format.js";

interface Candidate {
  fact: SupportedFact;
  order: number;
  latestRef: number;
  words: Set<string>;
}

/** Scoring alone ignores case and standalone numbers; original facts and evidence remain unchanged. */
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}_][\p{L}\p{N}_-]*/gu) ?? []);
}

function latestRef(fact: SupportedFact): number {
  return fact.refs.reduce((latest, ref) => Math.max(latest, ref), -1);
}

/**
 * Bring distant repetitions together for model comparison without inferring equivalence.
 * Every input fact appears in exactly one group. The caller validates that single facts fit;
 * the predicate applies the actual serialized request budget to every additional candidate.
 */
export function groupFacts(facts: SupportedFact[], fits: (group: SupportedFact[]) => boolean): SupportedFact[][] {
  const remaining: Candidate[] = facts.map((fact, order) => ({ fact, order, latestRef: latestRef(fact), words: words(fact.text) }))
    .sort((a, b) => a.latestRef - b.latestRef || a.order - b.order);
  const frequencies = new Map<string, number>();
  for (const candidate of remaining) {
    for (const word of candidate.words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  }
  // Common phrasing should not outrank a topic or identifier shared by a few facts.
  const weights = new Map([...frequencies].map(([word, count]) => [word, Math.log(1 + facts.length / count)]));
  const similarity = (a: Candidate, b: Candidate): number => {
    const union = new Set([...a.words, ...b.words]);
    let shared = 0, total = 0;
    for (const word of union) {
      const weight = weights.get(word)!;
      total += weight;
      if (a.words.has(word) && b.words.has(word)) shared += weight;
    }
    const lexical = total ? shared / total : 0;
    // These are small tie preferences, never a partition: corrections by another speaker can still meet.
    return lexical + (a.fact.speaker === b.fact.speaker ? 0.01 : 0) + (a.fact.kind === b.fact.kind ? 0.005 : 0);
  };
  const groups: SupportedFact[][] = [];
  while (remaining.length) {
    const group = [remaining.shift()!];
    while (remaining.length) {
      const ranked = remaining.map((candidate, index) => ({ candidate, index,
        score: Math.max(...group.map(member => similarity(member, candidate))) }))
        .sort((a, b) => b.score - a.score || a.candidate.latestRef - b.candidate.latestRef || a.candidate.order - b.candidate.order);
      const selected = ranked.find(({ candidate }) => fits([...group.map(member => member.fact), candidate.fact]));
      if (!selected) break;
      group.push(selected.candidate);
      remaining.splice(selected.index, 1);
    }
    // Evidence chronology, including later corrections, is explicit in every model comparison.
    group.sort((a, b) => a.latestRef - b.latestRef || a.order - b.order);
    groups.push(group.map(member => member.fact));
  }
  return groups;
}
