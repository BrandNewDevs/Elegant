import { decisionChanges } from "./decision-history.js";
import type { Summary, Transcript } from './pipeline.js';

export interface OverviewSentence { text: string; refs: number[] }
const proposal = /\b(?:I|we) (?:propose|suggest|prefer)\b/iu;
const response = /^(?:agreed\b|I (?:agree|disagree|oppose|support)\b|I do not agree\b|no[,;.!\s])/iu;
const quoted = /["“”]|\b(?:quoted|hypothetical|test sentence|for example)\b/iu;
const sentenceCount = (text: string) => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].length;
const fits = (text: string) => (text.match(/\S+/gu)?.length ?? 0) <= 90 && sentenceCount(text) <= 3;

/** Relate an explicit reply to the immediately preceding proposal. Wording stays
 * verbatim and individually attributed: an agreement by one person is not consensus.
 * Do not guess the subject of distant replies, overlapping speech or quoted dialogue.
 */
export function summaryExchanges(transcript: Transcript): OverviewSentence[] {
  return transcript.segments.flatMap((reply, ref) => {
    const previous = transcript.segments[ref - 1];
    if (!previous || previous.speaker === reply.speaker || reply.start < previous.end
        || reply.start - previous.end > 120 || !proposal.test(previous.text)
        || !response.test(reply.text.trim()) || quoted.test(previous.text) || quoted.test(reply.text)
        || sentenceCount(previous.text) !== 1) return [];
    const text = `${previous.speaker}: ${previous.text.trim()} ${reply.speaker} responded: ${reply.text.trim()}`;
    return fits(text) ? [{ text, refs: [ref - 1, ref] }] : [];
  });
}

/** Replace only overview sentences wholly covered by the exchange. Preserve every
 * other selected point and its evidence; skip enrichment if the overview cannot fit.
 */
export function contextualOverview(transcript: Transcript, sentences: OverviewSentence[]): OverviewSentence[] {
  let result = sentences;
  for (const exchange of summaryExchanges(transcript)) {
    const covered = result.filter(s => s.refs.length && s.refs.every(ref => exchange.refs.includes(ref)));
    if (!covered.length || !covered.some(s => s.refs.includes(exchange.refs[0]!))) continue;
    const first = result.indexOf(covered[0]!);
    const next = result.flatMap((s, i) => i === first ? [exchange] : covered.includes(s) ? [] : [s]);
    if (fits(next.map(s => s.text).join(' '))) result = next;
  }
  return result;
}

/** Preserve short replies that extraction normally drops, with their actual subject.
 * This is contextual quotation, never transferring the proposed work to the responder.
 */
export function retainExchangeResponses(transcript: Transcript, summary: Summary): Summary {
  if (!summary.evidence) return summary;
  const changes = decisionChanges(transcript.segments.map((s, ref) => ({ speaker: s.speaker, text: s.text, refs: [ref] })));
  for (const exchange of summaryExchanges(transcript)) {
    const replyRef = exchange.refs[1]!, reply = transcript.segments[replyRef]!;
    if (!/^(?:agreed|I agree|I disagree|no)[.!\s]*$/iu.test(reply.text)) continue;
    let index = summary.participants.findIndex(p => p.speaker === reply.speaker);
    if (index !== -1 && summary.evidence.participants[index]!.said.some(refs => refs.includes(replyRef))) continue;
    if (index === -1) {
      index = summary.participants.length;
      summary.participants.push({ speaker: reply.speaker, said: [] });
      summary.evidence.participants.push({ speaker: reply.speaker, said: [] });
    }
    const source = transcript.segments[exchange.refs[0]!]!;
    const change = changes.find(c => c.earlier === exchange.refs[0]);
    summary.participants[index]!.said.push(`${change ? 'Earlier response (superseded proposal): ' : ''}In response to the proposal from ${source.speaker} (${source.text.trim()}): ${reply.text.trim()}`);
    summary.evidence.participants[index]!.said.push([...exchange.refs, ...(change ? [change.replacement] : [])]);
  }
  return summary;
}
