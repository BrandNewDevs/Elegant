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
    const result = override?.(stage, data) ?? (stage === 'tldr' ? { sentences: [{ text: data.points[data.statusPointIds?.[0] ?? 0].text, covers: [data.statusPointIds?.[0] ?? 0] }] } : { points: [{ ...point, ...(stage === 'reduce' ? { covers: data.claims.map((_: unknown, i: number) => i) } : {}) }] });
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
  it('fails clearly when every attempt still supplies only an oversized sentence', async () => {
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
    expect(isSummaryHousekeeping('and the core engine specifically.')).toBe(true);
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
  it('extracts exact repeated complete passages once and keeps the latest original references', async () => {
    const repeated = 'The permission guide explains microphone access and system audio access separately, describes the buttons that trigger each permission request, and documents the recovery steps for a previously denied permission without making an implementation commitment.';
    let copiesSent = 0;
    const fake: TextModel = { async complete(request) {
      const { data } = JSON.parse(request.messages[1]!.content);
      copiesSent += data.evidence?.filter((e: { text: string }) => e.text === repeated).length ?? 0;
      return { text: JSON.stringify(data.points ? { sentences: [{ text: data.points[data.statusPointIds?.[0] ?? 0].text, covers: [data.statusPointIds?.[0] ?? 0] }] } : { points: [] }), metadata: { model: 'fake', elapsedMs: 1 } };
    } };
    const result = await createReadableSummariser({ model: fake })({ segments: [
      { start: 0, end: 5, speaker: 'You', text: repeated },
      { start: 6, end: 7, speaker: 'Speaker 1', text: 'No owner assigned.' },
      { start: 8, end: 13, speaker: 'You', text: repeated },
    ] });
    expect(copiesSent).toBe(1);
    expect(result.participants.find(p => p.speaker === 'You')!.said).toEqual([repeated]);
    expect(result.evidence!.participants.find(p => p.speaker === 'You')!.said).toEqual([[2]]);
    expect(result.participants.find(p => p.speaker === 'Speaker 1')!.said).toContain('No owner assigned.');
  });
  it('retains explicit unresolved status when the model selects only an implementation update', async () => {
    const fake = model(stage => stage === 'tldr' ? { sentences: [{ text: 'The model runs locally.', covers: [0] }] } : undefined);
    const result = await createReadableSummariser({ model: fake })(transcript);
    expect(result.tldr).toContain('No owner assigned.');
    expect(result.generation!.requests!.filter(r => r.stage === 'tldr')).toHaveLength(1);
  });
  it('honours cancellation before contacting the model', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createReadableSummariser({ model: model() })(transcript, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('TLDR recovery at the production Summary seam', () => {
  function scriptedModel(overview: (points: any[]) => unknown, extraction?: (evidence: any[]) => unknown): TextModel {
    return { async complete(request) {
      const { data } = JSON.parse(request.messages[1]!.content);
      if (data.points) {
        const schema = request.schema as { properties: { sentences: { minItems: number; maxItems: number; items: { required: string[] } } } };
        expect(schema.properties.sentences.minItems).toBe(1);
        expect(schema.properties.sentences.maxItems).toBe(3);
        expect(schema.properties.sentences.items.required).toEqual(expect.arrayContaining(['text', 'covers']));
      }
      const result = data.points ? overview(data.points)
        : data.claims ? { points: data.claims.map((p: any, id: number) => ({ speaker: p.speaker, text: p.text, kind: p.kind, covers: [id] })) }
        : extraction?.(data.evidence) ?? { points: [] };
      return { text: JSON.stringify(result), metadata: { model: 'schema-recovery', elapsedMs: 0 } };
    } };
  }
  it('recovers from three valid 57-word selections instead of rejecting 171 words', async () => {
    const segments = ['Alpha', 'Beta', 'Gamma'].map((name, id) => ({ start: id * 20, end: id * 20 + 15, speaker: 'You', text: `${name} ${Array(56).fill('progress').join(' ')}.` }));
    const result = await createReadableSummariser({ model: scriptedModel(points => ({ sentences: points.map((p, id) => ({ text: p.text, covers: [id] })) })) })({ segments });
    expect(result.tldr.split(/\s+/u).length).toBeLessThanOrEqual(90);
    expect(result.tldr).toContain('Alpha');
    expect(result.participants[0]!.said).toHaveLength(3);
    expect(result.generation!.requests!.filter(r => r.stage === 'tldr')).toHaveLength(1);
  });
  it('compresses one oversized source point without truncating its supported sentence', async () => {
    const text = `The app runs locally ${Array(167).fill('carefully').join(' ')}.`;
    const result = await createReadableSummariser({ model: scriptedModel(() => ({ sentences: [{ text: 'The app runs locally.', covers: [0] }] })) })({ segments: [{ start: 0, end: 90, speaker: 'You', text }] });
    expect(result.tldr).toBe('The app runs locally.');
    expect(result.participants[0]!.said[0]!.split(/\s+/u).length).toBeGreaterThan(90);
    expect(result.evidence!.tldr).toEqual([0]);
    const commitment = `I will review the guide Thursday ${Array(150).fill('carefully').join(' ')}.`;
    const owned = await createReadableSummariser({ model: scriptedModel(() => ({ sentences: [{ text: 'I will review the guide Thursday.', covers: [0] }] })) })({ segments: [{ start: 0, end: 90, speaker: 'You', text: commitment }] });
    expect(owned.tldr).toBe('You: I will review the guide Thursday.');
    const attribution = await createReadableSummariser({ model: scriptedModel(points => ({ sentences: [{ text: points[0].text, covers: [0] }] })) })({ segments: [{ start: 0, end: 5, speaker: 'Speaker 1', text: "For the core engine I'm using Swift." }] });
    expect(attribution.tldr).toBe("Speaker 1: For the core engine I'm using Swift.");
  });
  it('accepts separate supported facts from unpunctuated independent clauses', async () => {
    const result = await createReadableSummariser({ model: scriptedModel(points => ({ sentences: points.map((p, id) => ({ text: p.text, covers: [id] })) }), evidence => ({ points: [
      { speaker: 'You', text: 'The app runs locally.', sources: [evidence[0].id], kind: 'update' },
      { speaker: 'You', text: 'It records meetings.', sources: [evidence[0].id], kind: 'update' },
      { speaker: 'You', text: 'It produces summaries.', sources: [evidence[0].id], kind: 'update' },
    ] })) })({ segments: [{ start: 0, end: 30, speaker: 'You', text: 'The app runs locally and it records meetings and it produces summaries' }] });
    expect(result.participants[0]!.said).toHaveLength(3);
    expect(result.evidence!.participants[0]!.said).toEqual([[0], [0], [0]]);
  });
  it('reserves status within the total word budget instead of overflowing after insertion', async () => {
    const texts = ['Alpha', 'Beta', 'Gamma'].map(name => `${name} ${Array(29).fill('progress').join(' ')}.`);
    texts.push(`No owner assigned ${Array(32).fill('progress').join(' ')}.`);
    const result = await createReadableSummariser({ model: scriptedModel(points => ({ sentences: points.slice(0, 3).map((p, id) => ({ text: p.text, covers: [id] })) })) })({ segments: texts.map((text, id) => ({ start: id * 20, end: id * 20 + 15, speaker: 'You', text })) });
    expect(result.tldr).toContain('No owner assigned');
    expect(result.tldr).toContain('Alpha');
    expect(result.tldr.split(/\s+/u).length).toBeLessThanOrEqual(90);
    expect(result.participants[0]!.said).toHaveLength(4);
  });
  it('derives citations from validated covers rather than model-added prose annotations', async () => {
    const result = await createReadableSummariser({ model: scriptedModel(() => ({ sentences: [{ text: 'No owner assigned [covers: 999].', covers: [0] }] })) })({ segments: [{ start: 0, end: 10, speaker: 'You', text: 'No owner assigned.' }] });
    expect(result.tldr).toBe('No owner assigned.');
    expect(result.evidence!.tldr).toEqual([0]);
  });
  it('rejects an unknown citation before discarding any over-budget sentence', async () => {
    await expect(createReadableSummariser({ model: scriptedModel(() => ({ sentences: [{ text: 'The app runs locally.', covers: [999] }] })) })({ segments: [{ start: 0, end: 1, speaker: 'You', text: 'The app runs locally.' }] })).rejects.toThrow('Use supplied evidence or claim IDs');
  });
  it('allows distinct supported sentences to refer to the same long point', async () => {
    const result = await createReadableSummariser({ model: scriptedModel(() => ({ sentences: [
      { text: 'The app records meetings.', covers: [0] },
      { text: 'The app produces summaries.', covers: [0] },
    ] })) })({ segments: [{ start: 0, end: 20, speaker: 'You', text: 'The app records meetings and produces summaries.' }] });
    expect(result.tldr).toBe('The app records meetings. The app produces summaries.');
    expect(result.evidence!.tldr).toEqual([0]);
  });
  it('keeps a confirmed final decision when the model selects only earlier proposals', async () => {
    const texts = ['My initial proposal is Monday with PDF export.', 'I propose Friday and Markdown instead.', 'Agreed. Friday replaces Monday and Markdown replaces PDF. These are the final decisions.'];
    const result = await createReadableSummariser({ model: scriptedModel(points => ({ sentences: points.slice(0, 2).map((point, id) => ({ text: point.text, covers: [id] })) })) })({ segments: texts.map((text, id) => ({ start: id * 20, end: id * 20 + 10, speaker: 'You', text })) });
    expect(result.tldr).toContain('Friday replaces Monday');
    expect(result.tldr).toContain('Markdown replaces PDF');
    expect(result.evidence!.tldr).toContain(2);
    expect(result.tldr.split(/\s+/u).length).toBeLessThanOrEqual(90);
  });
  it('leads with final outcomes and retains a retest commitment ahead of earlier proposals', async () => {
    const texts = ['My initial proposal is Monday with PDF export.', 'I propose Friday and Markdown instead.',
      'Agreed. Friday replaces Monday and Markdown replaces PDF. These are the final decisions.',
      'I will run the offline test again on Wednesday.', 'We did not set a calendar date for Friday.'];
    const result = await createReadableSummariser({ model: scriptedModel(points => ({ sentences: points.slice(0, 3).map((point, id) => ({ text: point.text, covers: [id] })) })) })({
      segments: texts.map((text, id) => ({ start: id * 20, end: id * 20 + 10, speaker: id === 0 || id === 2 ? 'You' : 'Speaker 1', text })),
    });
    expect(result.tldr).toMatch(/^Agreed[;. ]+Friday replaces Monday/u);
    expect(result.tldr).toContain('Speaker 1: I will run the offline test again on Wednesday.');
    expect(result.tldr).not.toContain('initial proposal');
    expect(result.tldr).not.toContain('I propose');
    expect(result.evidence!.tldr).toEqual([2, 3, 4]);
    expect(result.participants[0]!.said.join(' ')).toContain('initial proposal');
  });
  it('does not promote quoted or conditional will statements over substantive updates', async () => {
    const texts = ['The model runs locally.', 'It creates summaries.', 'The tests are not finished.',
      'If the tests pass, I will launch Friday.', 'This is quoted test material: I will launch Monday.'];
    const result = await createReadableSummariser({ model: scriptedModel(points => ({ sentences: points.slice(0, 3).map((point, id) => ({ text: point.text, covers: [id] })) })) })({
      segments: texts.map((text, id) => ({ start: id * 20, end: id * 20 + 10, speaker: 'You', text })),
    });
    expect(result.tldr).toContain('The model runs locally.');
    expect(result.tldr).not.toContain('launch');
  });
  it('fills a status-only model response with supported main updates', async () => {
    const texts = ['The model runs locally.', 'It creates summaries.', 'The tests are not finished.'];
    const result = await createReadableSummariser({ model: scriptedModel(points => {
      const id = points.findIndex(p => p.text.includes('tests are not finished'));
      return { sentences: [{ text: points[id].text, covers: [id] }] };
    }) })({ segments: texts.map((text, id) => ({ start: id * 10, end: id * 10 + 5, speaker: 'You', text })) });
    expect(result.tldr).toBe('The model runs locally. It creates summaries. The tests are not finished.');
    expect(result.evidence!.tldr).toEqual([0, 1, 2]);
  });
  it('uses spare budget for main context when a model selects secondary details and status', async () => {
    const texts = ['The app uses a local model.', 'The app uses a desktop window.', 'The tests are not finished.'];
    const result = await createReadableSummariser({ model: scriptedModel(points => ({ sentences: [1, 2].map(id => ({ text: points[id].text, covers: [id] })) })) })({ segments: texts.map((text, id) => ({ start: id * 10, end: id * 10 + 5, speaker: 'You', text })) });
    expect(result.tldr).toContain('The app uses a local model.');
    expect(result.tldr).toContain('The tests are not finished.');
    expect(result.tldr.split(/\s+/u).length).toBeLessThanOrEqual(90);
    expect(result.evidence!.tldr).toEqual([0, 1, 2]);
  });
  it('keeps negation, ownership, conditions and deadlines when a proposed TLDR drops them', async () => {
    for (const [original, invalid] of [
      ['We will write the guide Thursday.', 'You will write the guide Thursday.'],
      ['We will not launch Monday.', 'We will launch Monday.'],
      ['The tests are yet to be done.', 'The tests are done.'],
      ['The first release supports English only.', 'The first release supports English.'],
      ['We want to integrate calendars.', 'We integrate calendars.'],
      ['I am reviewing the guide.', 'I reviewed the guide.'],
      ['I can commit to reviewing the guide after someone writes it.', 'I review the guide.'],
      ['We will launch when the tests pass.', 'We will launch.'],
      ['If the tests pass, I will review the guide Thursday.', 'If the tests pass, she will review the guide Thursday.'],
      ['If the tests pass, we will launch Monday.', 'We will launch Monday.'],
      ['I will review the guide Thursday.', 'I will review the guide Friday.'],
      ['This is quoted test material: we approved cloud uploads.', 'We approved cloud uploads.'],
      ['If we retain audio and it includes private material we will review deletion.', 'We will review deletion.'],
    ]) {
      const result = await createReadableSummariser({ model: scriptedModel(() => ({ sentences: [{ text: invalid, covers: [0] }] })) })({ segments: [{ start: 0, end: 10, speaker: 'You', text: original! }] });
      expect(result.tldr).toContain(original!);
      expect(result.tldr).not.toBe(invalid);
    }
  });
});
