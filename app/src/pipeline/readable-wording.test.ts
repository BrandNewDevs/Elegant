import { expect, it } from 'vitest';
import { createReadableSummariser } from './readable-summariser.js';
import { createGeminiSummariser } from './gemini-pipeline.js';
import type { TextModel } from './language-model.js';

const local: TextModel = { async complete(request) {
  const { data } = JSON.parse(request.messages[1]!.content);
  const value = data.points ? { sentences: [{ text: data.points[0].text, covers: [0] }] }
    : data.claims ? { points: data.claims.map((c: any, id: number) => ({ ...c, covers: [id] })) }
    : { points: [] };
  return { text: JSON.stringify(value), metadata: { model: 'synthetic', elapsedMs: 0 } };
} };
const cases = [
  ['Okay, I will write the guide in order to help reviewers by Thursday.', 'I will write the guide to help reviewers by Thursday.'],
  ['At the present time, we may ship on Friday due to the fact that the tests passed.', 'Currently, we may ship on Friday because the tests passed.'],
  ['Repeating my earlier commitment: I will review the report on a weekly basis.', 'I will review the report weekly.'],
  ['The app utilizes local storage in order to keep audio on the Mac.', 'The app uses local storage to keep audio on the Mac.'],
];
it.each(cases)('shortens supported wording while retaining evidence: %s', async (source, expected) => {
  const transcript = { segments: [{ start: 0, end: 5, speaker: 'You', text: source! }] };
  const before = JSON.stringify(transcript);
  const result = await createReadableSummariser({ model: local })(transcript);
  expect(result.participants[0]!.said).toEqual([expected]);
  expect(result.tldr).toContain(expected!);
  expect(result.evidence!.participants[0]!.said).toEqual([[0]]);
  expect(JSON.stringify(transcript)).toBe(before);
});
it.each([
  'I think we may ship only if the tests pass.',
  'We will not ship before Friday.',
  'The function utilize must keep its name.',
  'She said "utilize local storage in order to keep audio".',
])('keeps meaning-bearing qualifiers and literal identifiers: %s', async source => {
  const result = await createReadableSummariser({ model: local })({ segments: [{ start: 0, end: 2, speaker: 'You', text: source }] });
  expect(result.participants[0]!.said).toEqual([source]);
});
it('accepts the same constrained wording in Gemini without a source fallback', async () => {
  const source = cases[0]![0]!, expected = cases[0]![1]!;
  let call = 0;
  const model: TextModel = { async complete() {
    return { text: JSON.stringify(call++ === 0
      ? { points: [{ speaker: 'You', text: expected, sourceIds: ['0:0'] }], omittedSourceIds: [] }
      : { points: [{ speaker: 'You', text: expected, covers: [0] }], tldr: { text: expected, pointIds: [0] } }), metadata: { model: 'synthetic', elapsedMs: 0 } };
  } };
  const result = await createGeminiSummariser({ model })({ segments: [{ start: 0, end: 2, speaker: 'You', text: source }] });
  expect(result.participants[0]!.said).toEqual([expected]);
  expect(result.tldr).toBe(expected);
  expect(result.generation!.fallbacks ?? 0).toBe(0);
});
it('does not rename a capitalized product while shortening ordinary prose', async () => {
  const source = 'Our product is named Utilize.';
  const result = await createReadableSummariser({ model: local })({ segments: [{ start: 0, end: 2, speaker: 'You', text: source }] });
  expect(result.participants[0]!.said).toEqual([source]);
});
