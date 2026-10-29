import { describe, it, expect } from 'vitest';
import { createReadableSummariser } from './readable-summariser.js';
import { summaryPassages, isSummaryHousekeeping } from './summary-passages.js';
import type { TextModel } from './language-model.js';
import { requestBytes } from './model-request.js';
const transcript = { segments: [
  { start: 0, end: 3, speaker: 'You', text: 'The model runs' },
  { start: 4, end: 7, speaker: 'You', text: 'locally. No owner assigned.' },
  { start: 8, end: 9, speaker: 'Speaker 1', text: 'Agreed.' },
] };
function model(override?: (stage: string, data: any) => unknown): TextModel {
  return { async complete(request) {
    expect(Number.isSafeInteger(request.timeoutMs)).toBe(true);
    expect(requestBytes(request)).toBeLessThanOrEqual(5500);
    expect(JSON.stringify(request.schema)).toContain('enum');
    const { instruction, data } = JSON.parse(request.messages[1]!.content);
    const stage = Array.isArray(data.points) ? 'tldr' : instruction.includes('Consolidate supplied') ? 'reduce' : 'extract';
    const point = { speaker: 'You', text: 'The model runs locally; ownership is unassigned.', sources: [0], kind: 'unresolved' };
    if (stage === 'extract') {
      expect(new Set(data.evidence.map((e: { speaker: string }) => e.speaker)).size).toBe(1);
      if (data.evidence.every((e: { speaker: string }) => e.speaker !== 'You')) return { text: JSON.stringify({ points: [] }), metadata: { model: 'fake', elapsedMs: 1 } };
    }
    const result = override?.(stage, data) ?? (stage === 'tldr' ? { sentences: [{ covers: [data.statusPointIds?.[0] ?? 0] }] } : { points: [{ ...point, ...(stage === 'reduce' ? { covers: data.claims.map((_: unknown, i: number) => i) } : {}) }] });
    return { text: JSON.stringify(result), metadata: { model: 'fake', elapsedMs: 1 } };
  } };
}
describe('readable Summary production seam', () => {
  it('reconstructs adjacent speech and preserves original ordinal evidence', async () => {
    expect(summaryPassages(transcript)[0]).toMatchObject({ text: 'The model runs locally. No owner assigned.', refs: [0, 1] });
    const result = await createReadableSummariser({ model: model() })(transcript);
    expect(result.evidence!.participants[0]!.said.flat()).toEqual(expect.arrayContaining([0, 1]));
    expect(result.participants[0]!.said.join(' ')).toContain('No owner assigned');
    expect(result.tldr).not.toContain('You:');
  });
  it('never joins across another speaker or a long pause', () => {
    expect(summaryPassages({ segments: [...transcript.segments, { start: 15, end: 16, speaker: 'You', text: 'Later.' }] })).toHaveLength(3);
  });
  it('rejects a selection exceeding the TLDR word budget', async () => {
    const fake = model(stage => stage === 'extract' ? { points: [{ speaker: 'You', text: 'word '.repeat(91), sources: [0], kind: 'update' }] } : undefined);
    await expect(createReadableSummariser({ attempts: 1, model: fake })({ segments: [{ start: 0, end: 1, speaker: 'You', text: 'word '.repeat(91) + '.' }] })).rejects.toThrow('90 words');
  });
  it('rejects foreign speaker evidence', async () => {
    await expect(createReadableSummariser({ attempts: 1, model: model(() => ({ points: [{ speaker: 'You', text: 'Wrong speaker.', kind: 'update', sources: [1] }] })) })(transcript)).rejects.toThrow(/supplied evidence|own speech/);
  });
  it('rejects missing claim coverage during consolidation', async () => {
    const fake = model((stage, data) => stage === 'extract' ? { points: [
      { speaker: 'You', text: 'The model runs locally.', sources: [0], kind: 'update' },
      { speaker: 'You', text: 'No owner assigned.', sources: [0], kind: 'unresolved' },
    ] } : stage === 'reduce' ? { points: [{ speaker: 'You', text: 'The model runs locally.', sources: [0], kind: 'update', covers: [0] }] } : undefined);
    await expect(createReadableSummariser({ attempts: 1, model: fake })(transcript)).rejects.toThrow('Missing covers IDs');
  });
  it('cleans known citation markers in points and rejects unknown markers', async () => {
    const fake = (marker: string) => model(stage => stage === 'extract' ? { points: [{ speaker: 'You', text: `The model runs locally ${marker}.`, sources: [0], kind: 'update' }] } : undefined);
    const result = await createReadableSummariser({ model: fake('[0]') })(transcript);
    expect(result.participants.flatMap(p => p.said)).toContain('The model runs locally.');
    await expect(createReadableSummariser({ attempts: 1, model: fake('[999]') })(transcript)).rejects.toThrow('all cited evidence IDs');
  });
  it('omits bare acknowledgements but retains a short substantive negative', async () => {
    const fake = model(stage => stage === 'extract' ? { points: [
      { speaker: 'You', text: 'No owner assigned.', sources: [0], kind: 'unresolved' },
      { speaker: 'You', text: 'Yes.', sources: [0], kind: 'update' },
    ] } : undefined);
    const before = JSON.stringify(transcript);
    const result = await createReadableSummariser({ model: fake })(transcript);
    expect(result.participants[0]!.said).toContain('No owner assigned.');
    expect(result.participants.flatMap(p => p.said)).not.toContain('Yes.');
    expect(JSON.stringify(transcript)).toBe(before);
  });
  it('filters only unambiguous housekeeping, preserving short negatives', () => {
    expect(isSummaryHousekeeping('So what are the updates on the app?')).toBe(true);
    expect(isSummaryHousekeeping('now you have to go on that only you and I have to go on this')).toBe(true);
    expect(isSummaryHousekeeping('Summary and Summary and Cut')).toBe(true);
    expect(isSummaryHousekeeping('I wanted to know our progress in the UI field')).toBe(true);
    for (const text of ['No owner assigned.', 'No.', 'Tests are not finished.', 'Friday replaces Monday.']) expect(isSummaryHousekeeping(text)).toBe(false);
  });
  it('retains an omitted supported claim after bounded consolidation retries', async () => {
    const fake = model(stage => stage === 'extract' ? { points: [
      { speaker: 'You', text: 'The model runs locally.', sources: [0], kind: 'update' },
      { speaker: 'You', text: 'No owner assigned.', sources: [0], kind: 'unresolved' },
    ] } : stage === 'reduce' ? { points: [{ speaker: 'You', text: 'The model runs locally.', kind: 'update', covers: [0] }] } : undefined);
    const result = await createReadableSummariser({ model: fake })(transcript);
    expect(result.participants[0]!.said).toContain('No owner assigned.');
  });
  it('uses integer timeouts when less than one model timeout remains', async () => {
    await expect(createReadableSummariser({ model: model(), deadlineMs: 1000 })(transcript)).resolves.toHaveProperty('tldr');
  });
  it('honours cancellation before contacting the model', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createReadableSummariser({ model: model() })(transcript, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
