import { isBareAgendaHeading } from './sentence-claims.js';
import type { Transcript } from './pipeline.js';

export interface SummaryPassage { id: number; speaker: string; text: string; refs: number[] }
/** Narrow conversation-management rules; short substantive negatives are retained. */
export function isSummaryHousekeeping(text: string): boolean {
  const value = text.trim().replace(/^(?:yeah|well|and)[,\s]+/iu, '');
  const words = value.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  const functionWords = new Set('i you we they he she it this that these those my your our their have has had to be is are was were am a an the of in on for and or but with by so just only now then here there go going went can could will would should may might please very'.split(' '));
  return isBareAgendaHeading(value)
    || /^(?:now|only)\b/iu.test(value) && words.length >= 4 && words.every(word => functionWords.has(word))
    || /^(\p{L}+)(?:\s+and\s+\1)+\s+and\s+cut[.!]*$/iu.test(value)
    || /^(?:all good[,\s]*)+[.!]*$/iu.test(value)
    || /^everything (?:is )?(?:working|going|progressing) (?:very )?(?:good|well|fine)[.!]*$/iu.test(value)
    || /^that is (?:very )?(?:nice|good|great|elegant)[.!]*$/iu.test(value)
    || /^(?:isn['’]t|is not) it fun[.!?]*$/iu.test(value)
    || /^(?:alright[,\s]+)?(?:so )?what about the .+ part\?$/iu.test(value)
    || /^(?:so )?let me[.!]*$/iu.test(value)
    || /^(?:I['’]ll get into the key functionalities|dive deep into what .+ does right now)[.!]*$/iu.test(value)
    || /^and (?:the )?(?:core engine|ui|user interface) specifically[.!]*$/iu.test(value)
    || /^(?:actually )?I(?:['’]m| am) interested in .+\b(?:please|put some light|tell me|explain)\b.+$/iu.test(value)
    || /^(?:so )?(?:let me )?dive (?:deep )?into what .+ does(?: right now)?[.!]*$/iu.test(value)
    || /^(?:thanks|thank you|bye|end|hopefully|is|now)[.!?,\s]*$/iu.test(value)
    || /^(?:so[,\s]+)?what (?:are|is) the updates? (?:on|for) .+\?$/iu.test(value)
    || /^let['’]s talk about .+ updates? .*[.!?]*$/iu.test(value)
    || /^I wanted to know (?:our |the )?progress .+$/iu.test(value)
    || /^I just joined and okay we are ready to go[.!]*$/iu.test(value)
    || /^(?:I|we(?: both)?) hope (?:it|this) works?(?: out)? (?:very )?well[.!]*$/iu.test(value)
    || /^(?:I|we) hope we get (?:a )?good .+$/iu.test(value)
    || /^(?:now[,\s]+)?(?:you have to |please )?stop recording[.!]*$/iu.test(value);
}
/** Working evidence only: the stored Transcript and its ordinal references never change. */
export function summaryPassages(transcript: Transcript): SummaryPassage[] {
  const turns: { speaker: string; text: string; refs: number[]; end: number }[] = [];
  let barrier = false;
  let closingSpeaker: string | undefined;
  transcript.segments.forEach((segment, ref) => {
    if (closingSpeaker !== segment.speaker) closingSpeaker = undefined;
    if (/^(?:end|(?:now )?(?:you have to |please )?stop recording)[.!\s]*$/iu.test(segment.text)) closingSpeaker = segment.speaker;
    if (closingSpeaker === segment.speaker && /^(?:it['’]s done|I['’]m done)[.!\s]*$/iu.test(segment.text)) { barrier = true; return; }
    if (isSummaryHousekeeping(segment.text)) { barrier = true; return; }
    const previous = turns.at(-1);
    if (!barrier && previous && previous.speaker === segment.speaker && segment.start - previous.end <= 2) {
      previous.text += ' ' + segment.text; previous.refs.push(ref); previous.end = Math.max(previous.end, segment.end);
    } else turns.push({ speaker: segment.speaker, text: segment.text, refs: [ref], end: segment.end });
    barrier = false;
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
