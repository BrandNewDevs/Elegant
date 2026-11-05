import { expect, it } from 'vitest';
import { createReadableSummariser } from './readable-summariser.js';
import type { TextModel } from './language-model.js';

function sourceModel(): TextModel {
  return { async complete(request) {
    const { data } = JSON.parse(request.messages[1]!.content);
    // Force conservative original wording, isolating application-owned history.
    const output = data.points ? { sentences: [{ text: data.points[0].text, covers: [0] }] }
      : data.claims ? { points: data.claims.map((c: any, id: number) => ({ ...c, covers: [id] })) }
      : { points: [] };
    return { text: JSON.stringify(output), metadata: { model: 'synthetic', elapsedMs: 0 } };
  } };
}
const segment = (text: string, i: number) => ({ text, speaker: 'You', start: i * 10, end: i * 10 + 2 });
it('marks an explicitly replaced position and excludes it from the overview', async () => {
  const result = await createReadableSummariser({ model: sourceModel() })({ segments: [
    segment('My initial proposal is Monday with PDF export.', 0),
    segment('Friday replaces Monday, and Markdown replaces PDF. These are the final decisions.', 1),
  ] });
  expect(result.participants[0]!.said[0]).toMatch(/^Earlier position \(superseded\):/);
  expect(result.evidence!.participants[0]!.said[0]).toEqual([0, 1]);
  expect(result.tldr).not.toContain('initial proposal');
  expect(result.tldr).toContain('Friday replaces Monday');
});
it.each([
  'If approved, Friday replaces Monday, and Markdown replaces PDF.',
  'I propose Friday replaces Monday, and Markdown replaces PDF.',
  'Friday does not replace Monday, and Markdown does not replace PDF.',
  'The quoted instruction says "Friday replaces Monday, and Markdown replaces PDF".',
])('does not turn a conditional, proposed, negative or quoted correction into a final change: %s', async correction => {
  const result = await createReadableSummariser({ model: sourceModel() })({ segments: [
    segment('My initial proposal is Monday with PDF export.', 0), segment(correction, 1),
  ] });
  expect(result.participants.flatMap(p => p.said).join(' ')).not.toContain('superseded');
});
it('keeps unrelated commitments and ambiguous same-value proposals', async () => {
  const result = await createReadableSummariser({ model: sourceModel() })({ segments: [
    segment('I propose Monday for release.', 0), segment('I propose Monday for the audit.', 1),
    segment('I will review the guide on Monday.', 2), segment('Friday replaces Monday.', 3),
  ] });
  expect(result.participants.flatMap(p => p.said).join(' ')).not.toContain('superseded');
});
