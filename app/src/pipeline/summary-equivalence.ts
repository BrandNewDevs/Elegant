import { readableWording } from './readable-wording.js';

/** A deliberately narrow equivalence relation, not a similarity score.
 * Reorder a single explicit weekday deadline and expand contractions, but keep
 * actor, word order, polarity, conditions, identifiers and all other details.
 * Context-dependent statements retain their context identity.
 */
export function summaryMeaningKey(speaker: string, original: string, context: string): string {
  let text = readableWording(original).replace(/\s+/gu, ' ').trim();
  const literal = () => JSON.stringify([speaker, text, context]);
  if (/["“”`]|\b(?:branch|file|path|variable|function|ticket|issue)\b/iu.test(text)) return literal();
  // Only an explicit individual promise with a concrete object is
  // independent of passage context. "I will test it" cannot identify a task.
  text = text.replace(/\bI['’]ll\b/gu, 'I will');
  const weekday = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
  const front = text.match(new RegExp(`^By (${weekday}),? (I will .+)[.!]$`, 'u'));
  if (front) text = `${front[2]} by ${front[1]}.`;
  text = text.replace(/^I will (?:perform|conduct) a review of /u, 'I will review ')
    .replace(/^I will (?:perform|conduct) a test of /u, 'I will test ');
  const selfContained = /^I will\s+\w+\s+.+/u.test(text)
    && !/\b(?:it|this|that|these|those|they|them|their|its|we|our|you|your|he|she|his|her|again|another|next|today|tomorrow|yesterday|if|unless|when|after|before|once|until|instead|then|now|later|soon|here|there|a|an)\b/iu.test(text)
    && !/[;:!?]|\b(?:and|or|but)\b/iu.test(text)
    && (text.match(/\.(?:\s|$)/gu) ?? []).length <= 1;
  if (!selfContained) return literal();
  // Definite articles do not change an explicitly named object's identity;
  // indefinite articles and quantities stay, as do case-sensitive names.
  text = text.replace(/\bthe /gu, '').replace(/[.!]$/u, '');
  return JSON.stringify([speaker, text]);
}

export function mergeEquivalent<T>(items: T[], key: (item: T) => string, merge: (first: T, next: T) => T): T[] {
  const result = new Map<string, T>();
  for (const item of items) {
    const identity = key(item), previous = result.get(identity);
    result.set(identity, previous === undefined ? item : merge(previous, item));
  }
  return [...result.values()];
}

/** A renewed promise after a correction must not be folded into its old state. */
export function repetitionEpoch(texts: string[], last: number): number {
  let epoch = 0;
  for (let i = 0; i <= last; i++) {
    if (/\b(?:cancel\w*|withdraw\w*|replac\w*|supersed\w*|instead|no longer|changed?|new task|next week|following week)\b/iu.test(texts[i] ?? '')) epoch++;
  }
  return epoch;
}
