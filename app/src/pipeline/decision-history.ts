/** Explicit correction links; ambiguous topic matches remain unclassified. */
export interface DecisionPoint { speaker: string; text: string; refs: number[] }
export interface DecisionChange { earlier: number; replacement: number }
const guarded = /\b(?:no|not|never|if|unless|provided|maybe|might|could|would|quoted|hypothetical|propose\w*|suggest\w*)\b|n['’]t\b|["“”]/iu;
const historical = /\b(?:propos\w*|suggest\w*|provisional|initial|agree\w*|decid\w*|plan\w*|choice)\b/iu;
const commitment = /\b(?:I|we) (?:will|shall)\b/iu;
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
const contains = (text: string, phrase: string) => (' ' + words(text).join(' ') + ' ').includes(' ' + words(phrase).join(' ') + ' ');

/** Only an explicit, affirmative replacement can retire an earlier position.
 * Multiple replacement values must all match, preventing a shared weekday alone
 * from retiring an unrelated proposal. A single value requires an unambiguous
 * earlier position. No last-mention-wins assumption is made.
 */
export function decisionChanges(points: DecisionPoint[]): DecisionChange[] {
  const changes = new Map<number, DecisionChange>();
  points.forEach((point, replacement) => {
    if (guarded.test(point.text)) return;
    const pairs = [...point.text.matchAll(/\b([\p{L}\p{N}_-]+) replaces? ([\p{L}\p{N}_-]+)\b/giu)]
      .map(match => ({ current: match[1]!, previous: match[2]! }));
    if (!pairs.length || pairs.some(p => p.current.toLowerCase() === p.previous.toLowerCase())) return;
    const candidates = points.flatMap((old, earlier) => {
      if (earlier === replacement || Math.max(...old.refs) >= Math.min(...point.refs)
          || !historical.test(old.text) || commitment.test(old.text)
          || !pairs.every(p => contains(old.text, p.previous) && !contains(old.text, p.current))) return [];
      return [earlier];
    });
    // Repeated statements of the same position are safe; distinct topics sharing
    // a value need an explicit topic relationship, which this resolver abstains on.
    if (pairs.length === 1 && new Set(candidates.map(i => words(points[i]!.text).join(' '))).size > 1) return;
    for (const earlier of candidates) changes.set(earlier, { earlier, replacement });
  });
  return [...changes.values()];
}
