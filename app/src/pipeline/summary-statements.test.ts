import { it, expect } from 'vitest';
import { matchStatements, sourceStatements } from './summary-statements.js';

it('rejects moved deadlines and omitted conditions even when the same words occur elsewhere', () => {
  const atoms = [
    { speaker: 'You', text: 'I will write the guide by Thursday.', sources: [0] },
    { speaker: 'You', text: 'I will review the tests by Friday.', sources: [1] },
  ];
  expect(() => matchStatements('I will write the guide by Friday and review the tests by Thursday.', 'You', atoms, 'commitment')).toThrow();
  expect(() => matchStatements('We will launch Monday.', 'You', [{ speaker: 'You', text: 'If the test passes, we will launch Monday.', sources: [0] }], 'decision')).toThrow();
});
it('does not infer an individual owner from a collective commitment', () => {
  expect(() => matchStatements('You will update the guide Thursday.', 'You', [{ speaker: 'You', text: 'We will update the guide Thursday.', sources: [0] }], 'commitment')).toThrow();
});
it('rejects unsupported revision and completion claims', () => {
  expect(() => matchStatements('Both PDF and Markdown require revision.', 'You', [{ speaker: 'You', text: 'Friday replaces Monday and Markdown replaces PDF.', sources: [0] }], 'decision')).toThrow();
  expect(() => matchStatements('Kenny completed his work.', 'Kenny', [{ speaker: 'Kenny', text: "It's done. I'm done.", sources: [0] }], 'update')).toThrow();
});
it('keeps original evidence identities when a sentence crosses adjacent fragments', () => {
  const atoms = sourceStatements([
    { id: 0, speaker: 'You', text: 'The model runs', refs: [0] },
    { id: 1, speaker: 'You', text: 'locally.', refs: [1] },
    { id: 2, speaker: 'Speaker 1', text: 'No owner assigned.', refs: [2] },
  ]);
  expect(atoms[0]).toMatchObject({ text: 'The model runs locally.', sources: [0, 1] });
  expect(matchStatements('The model runs locally.', 'You', [atoms[0]!], 'update')).toHaveLength(1);
});
it('keeps finality and synthetic qualifiers attached to the facts they qualify', () => {
  const final = sourceStatements([{ id: 0, speaker: 'You', refs: [0], text: 'Friday replaces Monday, and Markdown replaces PDF. These are the final decisions.' }]);
  expect(final).toHaveLength(1);
  expect(final[0]!.text).toContain('Friday replaces Monday');
  expect(final[0]!.text).toContain('final decisions');
  const synthetic = sourceStatements([{ id: 0, speaker: 'You', refs: [0], text: 'PDF failed. Markdown passed. These are test outcomes for this synthetic discussion, not measurements of the actual app.' }]);
  expect(synthetic).toHaveLength(1);
  expect(synthetic[0]!.text).toContain('PDF failed');
  expect(synthetic[0]!.text).toContain('not measurements');
});
