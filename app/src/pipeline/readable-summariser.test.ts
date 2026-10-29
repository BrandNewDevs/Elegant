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
    const { instruction, data } = JSON.parse(request.messages[1]!.content);
    const stage = instruction.includes('Write 2–3') ? 'tldr' : instruction.includes('Consolidate supplied') ? 'reduce' : 'extract';
    const point = { speaker: 'You', text: 'The model runs locally; ownership is unassigned.', sources: [0], kind: 'unresolved' };
    const result = override?.(stage, data) ?? (stage === 'tldr' ? { sentences: [{ text: 'The model runs locally. Ownership is unassigned.', sources: [0] }] } : { points: [{ ...point, ...(stage === 'reduce' ? { covers: data.claims.map((_: unknown, i: number) => i) } : {}) }] });
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
    await expect(createReadableSummariser({ attempts: 1, model: model(stage => stage === 'tldr' ? { sentences: [{ text: 'word '.repeat(91), sources: [0] }] } : undefined) })(transcript)).rejects.toThrow('90 words');
  });
  it('rejects foreign speaker evidence', async () => {
    await expect(createReadableSummariser({ attempts: 1, model: model(() => ({ points: [{ speaker: 'You', text: 'Wrong speaker.', kind: 'update', sources: [1] }] })) })(transcript)).rejects.toThrow('own speech');
  });
  it('honours cancellation before contacting the model', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createReadableSummariser({ model: model() })(transcript, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
