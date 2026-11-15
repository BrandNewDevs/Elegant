import { expect, it } from 'vitest';
import { createReadableSummariser } from './readable-summariser.js';
import { createGeminiSummariser } from './gemini-pipeline.js';
import type { TextModel } from './language-model.js';

const transcript = (texts: string[]) => ({ segments: texts.map((text, i) => ({ speaker: 'You', text, start: i * 10, end: i * 10 + 2 })) });
const local: TextModel = { async complete(request) {
  const { data } = JSON.parse(request.messages[1]!.content);
  const result = data.points ? { sentences: [
    { text: data.points[0].text, covers: [0] },
    { text: data.points[0].text.replace('the ', ''), covers: [0] },
  ] } : data.claims ? { points: data.claims.map((p: any, id: number) => ({ ...p, covers: [id] })) }
    : { points: data.evidence.map((p: any) => ({ speaker: p.speaker, text: p.text, sources: [p.id], kind: 'commitment' })) };
  return { text: JSON.stringify(result), metadata: { model: 'synthetic', elapsedMs: 1 } };
} };

it('collapses dated commitment paraphrases across passages and retains all citations', async () => {
  const input = transcript(['I will review the Markdown export by Friday.', 'By Friday, I will review Markdown export.', "I’ll review the Markdown export by Friday."]);
  const output = await createReadableSummariser({ model: local })(input);
  expect(output.participants[0]!.said).toEqual(['I will review the Markdown export by Friday.']);
  expect(output.evidence!.participants[0]!.said).toEqual([[0, 1, 2]]);
  expect(output.tldr).toBe('You: I will review the Markdown export by Friday.');
  expect(output.evidence!.tldr).toEqual([0, 1, 2]);
});

it.each([
  'I will review the Markdown export by Thursday.',
  'I will review the Markdown export on Friday.',
  'I will not review the Markdown export by Friday.',
  'We will review the Markdown export by Friday.',
  'I may review the Markdown export by Friday.',
  'I will review the Markdown export if approved by Friday.',
  'I will review the HTML export by Friday.',
  'I will review the markdown export by Friday.',
  'I will review another Markdown export by Friday.',
])('keeps distinct commitment details: %s', async second => {
  const output = await createReadableSummariser({ model: local })(transcript(['I will review the Markdown export by Friday.', second]));
  expect(output.participants[0]!.said).toHaveLength(2);
  expect(output.evidence!.participants[0]!.said).toEqual([[0], [1]]);
});

it('does not conflate context-dependent objects', async () => {
  const output = await createReadableSummariser({ model: local })(transcript([
    'The Mac build needs testing. I will test it by Friday.',
    'The Linux build needs testing. I will test it by Friday.',
  ]));
  expect(output.participants[0]!.said.join(' ')).toContain('Mac');
  expect(output.participants[0]!.said.join(' ')).toContain('Linux');
  expect(output.participants[0]!.said.filter(p => p.includes('I will test it'))).toHaveLength(2);
});

it('deduplicates Gemini draft commitments without discarding original evidence', async () => {
  let requests = 0;
  const model: TextModel = { async complete(request) {
    requests++;
    const content = request.messages.at(-1)!.content;
    // The final request must retain both original fragments but only one draft.
    if (requests === 2) {
      expect(content).toContain('0:0'); expect(content).toContain('1:0');
    }
    return { text: JSON.stringify(requests === 1 ? { points: [
      { speaker: 'You', text: 'I will review the export by Friday.', sourceIds: ['0:0'] },
      { speaker: 'You', text: 'By Friday, I will review the export.', sourceIds: ['1:0'] },
    ], omittedSourceIds: [] } : { points: [0, 1].map(() => ({ speaker: 'You', text: 'I will review the export by Friday.', covers: [0] })),
      tldr: { text: 'I will review the export by Friday. I will review the export by Friday.', pointIds: [0, 1] } }), metadata: { model: 'synthetic', elapsedMs: 1 } };
  } };
  const output = await createGeminiSummariser({ model })(transcript(['I will review the export by Friday.', 'By Friday, I will review the export.']));
  expect(output.participants[0]!.said).toEqual(['I will review the export by Friday.']);
  expect(output.evidence!.participants[0]!.said).toEqual([[0, 1]]);
  expect([...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(output.tldr)]).toHaveLength(1);
});

it('recognizes action-noun paraphrases while preserving deadline and provenance', async () => {
  const output = await createReadableSummariser({ model: local })(transcript([
    'I will review the export by Friday.', 'I will conduct a review of the export by Friday.',
  ]));
  expect(output.participants[0]!.said).toEqual(['I will review the export by Friday.']);
  expect(output.evidence!.participants[0]!.said).toEqual([[0, 1]]);
});

it('keeps renewed commitments on both sides of a cancellation', async () => {
  const output = await createReadableSummariser({ model: local })(transcript([
    'I will review the export by Friday.', 'I cancelled the export review.', 'I will review the export by Friday.',
  ]));
  expect(output.participants[0]!.said.filter(p => p === 'I will review the export by Friday.')).toHaveLength(2);
  expect(output.evidence!.participants[0]!.said).toEqual([[0], [1], [2]]);
});

it('merges repeats across extraction batches without exceeding the request budget', async () => {
  let extractions = 0;
  const counted: TextModel = { async complete(request) {
    const { data } = JSON.parse(request.messages[1]!.content);
    if (data.evidence && !data.claims) extractions++;
    expect(Buffer.byteLength(JSON.stringify(request.messages))).toBeLessThan(5500);
    return local.complete(request);
  } };
  const texts = Array.from({ length: 60 }, (_, i) => i % 2 ? 'By Friday, I will review the export.' : 'I will review the export by Friday.');
  const output = await createReadableSummariser({ model: counted })(transcript(texts));
  expect(extractions).toBeGreaterThan(1);
  expect(output.participants[0]!.said).toEqual(['I will review the export by Friday.']);
  expect(output.evidence!.participants[0]!.said[0]).toEqual(texts.map((_, i) => i));
});

it('keeps identical commitments under their own Participants', async () => {
  const input = transcript(['I will review the export by Friday.', 'I will review the export by Friday.']);
  input.segments[1]!.speaker = 'Speaker 1';
  const output = await createReadableSummariser({ model: local })(input);
  expect(output.participants).toHaveLength(2);
  expect(output.evidence!.participants.map(p => p.said)).toEqual([[[0]], [[1]]]);
});

it('merges explicit commitments without requiring a deadline', async () => {
  const output = await createReadableSummariser({ model: local })(transcript([
    'I will review the export.', 'I will conduct a review of the export.',
  ]));
  expect(output.participants[0]!.said).toEqual(['I will review the export.']);
  expect(output.evidence!.participants[0]!.said).toEqual([[0, 1]]);
});

it.each([false, true])('keeps the stronger only-assignment qualifier regardless of mention order (%s)', async reverse => {
  const texts = ['I will test the permission flow on the Mac by Thursday.', 'My only assignment: I will test the permission flow on the Mac by Thursday.'];
  const output = await createReadableSummariser({ model: local })(transcript(reverse ? [...texts].reverse() : texts));
  expect(output.participants[0]!.said).toEqual([texts[1]]);
  expect(output.evidence!.participants[0]!.said).toEqual([[0, 1]]);
  expect(output.tldr).toContain('My only assignment:');
});
