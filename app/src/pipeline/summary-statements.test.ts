import { it, expect } from 'vitest';
import { createReadableSummariser } from './readable-summariser.js';
import type { TextModel } from './language-model.js';
import type { Transcript } from './pipeline.js';

/** Exercise verification through the production Summary interface, with a model that proposes a rewrite. */
async function summarise(texts: string[], rewrite: string, kind = 'commitment') {
  const model: TextModel = { async complete(request) {
    const { data } = JSON.parse(request.messages[1]!.content);
    const result = data.points ? { sentences: [{ covers: [data.statusPointIds?.[0] ?? 0] }] }
      : data.claims ? { points: data.claims.map((claim: object, id: number) => ({ ...claim, covers: [id] })) }
      : { points: [{ speaker: 'You', text: rewrite, sources: data.evidence.map((e: { id: number }) => e.id), kind }] };
    return { text: JSON.stringify(result), metadata: { model: 'fake', elapsedMs: 1 } };
  } };
  const transcript: Transcript = { segments: texts.map((text, i) => ({ start: i * 4, end: i * 4 + 3, speaker: 'You', text })) };
  return createReadableSummariser({ model })(transcript);
}

it('preserves task deadlines and conditions when a proposed rewrite moves or omits them', async () => {
  const result = await summarise(['I will write the guide by Thursday.', 'I will review the tests by Friday.'], 'I will write the guide by Friday and review the tests by Thursday.');
  expect(result.participants[0]!.said.join(' ')).toContain('write the guide by Thursday');
  expect(result.participants[0]!.said.join(' ')).toContain('review the tests by Friday');
  const conditional = await summarise(['If the test passes, we will launch Monday.'], 'We will launch Monday.', 'decision');
  expect(conditional.participants[0]!.said.join(' ')).toContain('If the test passes');
});
it('does not assign a collective commitment to an individual Participant', async () => {
  const result = await summarise(['We will update the guide Thursday.'], 'You will update the guide Thursday.');
  expect(result.participants[0]!.said).toEqual(['We will update the guide Thursday.']);
});
it('does not publish unsupported revision or completion claims', async () => {
  const revision = await summarise(['Friday replaces Monday and Markdown replaces PDF.'], 'Both PDF and Markdown require revision.', 'decision');
  expect(revision.participants[0]!.said).toEqual(['Friday replaces Monday and Markdown replaces PDF.']);
  const completion = await summarise(["It's done. I'm done."], 'You completed all the work.', 'update');
  expect(completion.participants[0]!.said.join(' ')).not.toContain('completed all the work');
});
it('keeps original ordinal evidence when a supported sentence crosses adjacent fragments', async () => {
  const result = await summarise(['The model runs', 'locally.'], 'The model runs locally.', 'update');
  expect(result.participants[0]!.said).toEqual(['The model runs locally.']);
  expect(result.evidence!.participants[0]!.said).toEqual([[0, 1]]);
});
it('keeps finality and test-scope qualifiers with the facts they qualify', async () => {
  const final = await summarise(['Friday replaces Monday, and Markdown replaces PDF. These are the final decisions.'], 'These are the final decisions.', 'decision');
  expect(final.participants[0]!.said).toHaveLength(1);
  expect(final.participants[0]!.said[0]).toContain('Friday replaces Monday');
  expect(final.participants[0]!.said[0]).toContain('final decisions');
  const synthetic = await summarise(['PDF failed. Markdown passed. These are test outcomes for this synthetic discussion, not measurements of the actual app.'], 'PDF failed and Markdown passed.', 'update');
  expect(synthetic.participants[0]!.said).toHaveLength(1);
  expect(synthetic.participants[0]!.said[0]).toContain('not measurements');
});

it('omits a bare acknowledgement without losing adjacent unresolved ownership', async () => {
  const result = await summarise(['Understood. No owner assigned.'], 'Understood.', 'update');
  expect(result.participants[0]!.said).toEqual(['No owner assigned.']);
  expect(result.tldr).not.toContain('Understood');
});

it('preserves a commitment sharing a segment with a request for updates', async () => {
  const result = await summarise(['I wanted to know the progress in the UI. I will write the permission guide by Thursday.'], 'I will write the permission guide by Thursday.');
  expect(result.participants[0]!.said).toEqual(['I will write the permission guide by Thursday.']);
  expect(result.evidence!.participants[0]!.said).toEqual([[0]]);
});
