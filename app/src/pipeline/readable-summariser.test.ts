import { describe, it, expect } from 'vitest';
import { createReadableSummariser } from './readable-summariser.js';
import { summaryPassages } from './summary-passages.js';
import type { TextModel } from './language-model.js';
import { requestBytes } from './model-request.js';
const transcript = { segments: [
  { start: 0, end: 3, speaker: 'You', text: 'The model runs' },
  { start: 4, end: 7, speaker: 'You', text: 'locally. No owner assigned.' },
  { start: 8, end: 9, speaker: 'Speaker 1', text: 'Agreed.' },
] };
function model(override?: (stage: string, data: any) => unknown): TextModel {
  return { async complete(request) {
    expect(requestBytes(request)).toBeLessThanOrEqual(5500);
    expect(JSON.stringify(request.schema)).toContain('enum');
    const { instruction, data } = JSON.parse(request.messages[1]!.content);
    const stage = instruction.includes('Write 2–3') ? 'tldr' : instruction.includes('Consolidate supplied') ? 'reduce' : 'extract';
    const point = { speaker: 'You', text: 'The model runs locally; ownership is unassigned.', sources: [0], kind: 'unresolved' };
    const result = override?.(stage, data) ?? (stage === 'tldr' ? { sentences: [{ text: 'The model runs locally. Ownership is unassigned.', covers: [0] }] } : { points: [{ ...point, ...(stage === 'reduce' ? { covers: data.claims.map((_: unknown, i: number) => i) } : {}) }] });
    return { text: JSON.stringify(result), metadata: { model: 'fake', elapsedMs: 1 } };
  } };
}
describe('readable Summary production seam', () => {
  it('reconstructs adjacent speech and preserves original ordinal evidence', async () => {
    expect(summaryPassages(transcript)[0]).toMatchObject({ text: 'The model runs locally. No owner assigned.', refs: [0, 1] });
    const result = await createReadableSummariser({ model: model() })(transcript);
    expect(result.evidence!.participants[0]!.said).toEqual([[0, 1]]);
    expect(result.participants[0]!.said[0]).toContain('unassigned');
    expect(result.tldr).not.toContain('You:');
  });
  it('never joins across another speaker or a long pause', () => {
    expect(summaryPassages({ segments: [...transcript.segments, { start: 15, end: 16, speaker: 'You', text: 'Later.' }] })).toHaveLength(3);
  });
  it('rejects an oversized TLDR after bounded attempts', async () => {
    await expect(createReadableSummariser({ attempts: 1, model: model(stage => stage === 'tldr' ? { sentences: [{ text: 'word '.repeat(91), covers: [0] }] } : undefined) })(transcript)).rejects.toThrow('90 words');
  });
  it('rejects foreign speaker evidence', async () => {
    await expect(createReadableSummariser({ attempts: 1, model: model(() => ({ points: [{ speaker: 'You', text: 'Wrong speaker.', kind: 'update', sources: [1] }] })) })(transcript)).rejects.toThrow('own speech');
  });
  it('rejects missing claim coverage during consolidation', async () => {
    const fake = model((stage, data) => stage === 'extract' ? { points: [
      { speaker: 'You', text: 'Runs locally.', sources: [0], kind: 'update' },
      { speaker: 'You', text: 'No owner assigned.', sources: [0], kind: 'unresolved' },
    ] } : stage === 'reduce' ? { points: [{ speaker: 'You', text: 'Runs locally.', sources: [0], kind: 'update', covers: [0] }] } : undefined);
    await expect(createReadableSummariser({ attempts: 1, model: fake })(transcript)).rejects.toThrow('Missing covers IDs');
  });
  it('removes redundant known citation markers while rejecting unknown markers', async () => {
    const known = model(stage => stage === 'tldr' ? { sentences: [{ text: 'The model runs locally [0].', covers: [0] }] } : undefined);
    const result = await createReadableSummariser({ model: known })(transcript);
    expect(result.tldr).toBe('The model runs locally.');
    const unknown = model(stage => stage === 'tldr' ? { sentences: [{ text: 'The model runs locally [999].', covers: [0] }] } : undefined);
    await expect(createReadableSummariser({ attempts: 1, model: unknown })(transcript)).rejects.toThrow('all cited evidence IDs');
  });
  it('omits classified noise but retains a short substantive negative', async () => {
    const fake = model(stage => stage === 'extract' ? { points: [
      { speaker: 'You', text: 'No owner assigned.', sources: [0], kind: 'unresolved' },
      { speaker: 'Speaker 1', text: 'Agreed.', sources: [1], kind: 'housekeeping' },
    ] } : undefined);
    const before = JSON.stringify(transcript);
    const result = await createReadableSummariser({ model: fake })(transcript);
    expect(result.participants).toEqual([{ speaker: 'You', said: ['No owner assigned.'] }]);
    expect(JSON.stringify(transcript)).toBe(before);
  });
  it('honours cancellation before contacting the model', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createReadableSummariser({ model: model() })(transcript, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
