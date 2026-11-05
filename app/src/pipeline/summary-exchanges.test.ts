import { expect, it } from 'vitest';
import { createReadableSummariser } from './readable-summariser.js';
import type { TextModel } from './language-model.js';

const model: TextModel = { async complete(request) {
  const { data } = JSON.parse(request.messages[1]!.content);
  const value = data.points ? { sentences: [{ text: data.points[0].text, covers: [0] }] }
    : data.claims ? { points: data.claims.map((c: any, id: number) => ({ ...c, covers: [id] })) }
    : { points: [] };
  return { text: JSON.stringify(value), metadata: { model: 'synthetic', elapsedMs: 0 } };
} };
const input = (reply: string) => ({ segments: [
  { start: 0, end: 2, speaker: 'Speaker 1', text: 'I propose Markdown for export.' },
  { start: 3, end: 5, speaker: 'Speaker 2', text: reply },
] });
it.each(['Agreed.', 'I disagree.', 'Agreed, provided the offline test passes.'])('connects a proposal and reply without inventing consensus: %s', async reply => {
  const result = await createReadableSummariser({ model })(input(reply));
  expect(result.tldr).toContain('Speaker 1: I propose Markdown for export.');
  expect(result.tldr).toContain(`Speaker 2 responded: ${reply}`);
  expect(result.evidence!.tldr).toEqual([0, 1]);
  expect(result.tldr).not.toContain('We agreed');
  expect(result.participants.find(p => p.speaker === 'Speaker 2')!.said.join(' ')).toContain(reply);
});
it('retains a bare agreement with original subject and both source references', async () => {
  const result = await createReadableSummariser({ model })(input('Agreed.'));
  const index = result.participants.findIndex(p => p.speaker === 'Speaker 2');
  expect(result.participants[index]!.said[0]).toContain("Speaker 1's proposal (I propose Markdown for export.)");
  expect(result.evidence!.participants[index]!.said[0]).toEqual([0, 1]);
});
it('does not join a reply across an intervening topic', async () => {
  const transcript = input('Agreed.');
  transcript.segments.splice(1, 0, { start: 2, end: 3, speaker: 'You', text: 'The audit is complete.' });
  const result = await createReadableSummariser({ model })(transcript);
  expect(result.tldr).not.toContain('responded:');
});
it('does not interpret quoted proposals as real agreement', async () => {
  const transcript = input('Agreed.');
  transcript.segments[0]!.text = 'The test sentence is "I propose Markdown for export."';
  const result = await createReadableSummariser({ model })(transcript);
  expect(result.tldr).not.toContain('responded:');
});
it('does not resurrect an exchange superseded by a later correction', async () => {
  const transcript = input('Agreed.');
  transcript.segments.push({ start: 10, end: 12, speaker: 'You', text: 'PDF replaces Markdown. This is the final decision.' });
  const result = await createReadableSummariser({ model })(transcript);
  expect(result.tldr).toContain('PDF replaces Markdown');
  expect(result.tldr).not.toContain('responded:');
});
