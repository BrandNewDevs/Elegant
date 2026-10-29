import type { Transcript } from './pipeline.js';

export interface SummaryPassage { id: number; speaker: string; text: string; refs: number[] }
/** Narrow conversation-management rules; short substantive negatives are retained. */
export function isSummaryHousekeeping(text: string): boolean {
  const value = text.trim();
  return /^(?:yes|yeah|sure|okay|ok|absolutely|thanks|thank you|bye|end|hopefully|is|now)[.!?,\s]*$/iu.test(value)
    || /^(?:so[,\s]+)?what (?:are|is) the updates? (?:on|for) .+\?$/iu.test(value)
    || /^let['’]s talk about .+ updates? .*[.!?]*$/iu.test(value)
    || /^I wanted to know (?:our |the )?progress .+$/iu.test(value)
    || /^I just joined and okay we are ready to go[.!]*$/iu.test(value)
    || /^(?:I|we(?: both)?) hope (?:it|this) works?(?: out)? (?:very )?well[.!]*$/iu.test(value)
    || /^(?:now[,\s]+)?(?:you have to |please )?stop recording[.!]*$/iu.test(value);
}
/** Working evidence only: the stored Transcript and its ordinal references never change. */
export function summaryPassages(transcript: Transcript): SummaryPassage[] {
  const turns: { speaker: string; text: string; refs: number[]; end: number }[] = [];
  transcript.segments.forEach((segment, ref) => {
    const previous = turns.at(-1);
    if (previous && previous.speaker === segment.speaker && segment.start - previous.end <= 2) {
      previous.text += ' ' + segment.text; previous.refs.push(ref); previous.end = Math.max(previous.end, segment.end);
    } else turns.push({ speaker: segment.speaker, text: segment.text, refs: [ref], end: segment.end });
  });
  const passages: SummaryPassage[] = [];
  for (const turn of turns) {
    let text = '';
    const flush = () => { if (text.trim()) passages.push({ id: passages.length, speaker: turn.speaker, text: text.trim(), refs: turn.refs }); text = ''; };
    for (const sentence of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(turn.text)) {
      if (isSummaryHousekeeping(sentence.segment)) continue;
      if (text && Buffer.byteLength(text + sentence.segment, 'utf8') > 1000 && Buffer.byteLength(sentence.segment, 'utf8') <= 1000) flush();
      for (const word of sentence.segment.match(/\S+\s*/gu) ?? []) {
        if (Buffer.byteLength(word, 'utf8') > 1000) throw new Error('Summary incomplete: a word exceeds the evidence budget');
        if (Buffer.byteLength(text + word, 'utf8') > 1000) flush();
        text += word;
      }
      if (Buffer.byteLength(text, 'utf8') > 700) flush();
    }
    flush();
  }
  return passages;
}
