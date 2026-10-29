import { isSummaryHousekeeping, type SummaryPassage } from './summary-passages.js';

export interface SourceStatement { speaker: string; text: string; sources: number[] }
const bareAcknowledgement = /^(?:yes|yeah|sure|okay|ok|absolutely|agreed)[.!\s]*$/iu;
/** Recover sentences spanning adjacent fragments, without crossing another speaker's evidence. */
export function sourceStatements(evidence: SummaryPassage[]): SourceStatement[] {
  const runs: SummaryPassage[][] = [];
  for (const passage of [...evidence].sort((a, b) => a.id - b.id)) {
    const run = runs.at(-1), previous = run?.at(-1);
    if (previous && previous.speaker === passage.speaker && previous.id + 1 === passage.id
      && passage.refs[0]! <= previous.refs.at(-1)! + 1) run!.push(passage);
    else runs.push([passage]);
  }
  return runs.flatMap(run => {
    let text = '';
    const spans = run.map(p => { const start = text.length; text += (text ? ' ' : '') + p.text; return { id: p.id, start, end: text.length }; });
    return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].flatMap(sentence => {
      const value = sentence.segment.trim();
      if (!value || isSummaryHousekeeping(value) || bareAcknowledgement.test(value)) return [];
      return [{ speaker: run[0]!.speaker, text: value, sources: spans.filter(s => s.start < sentence.index + sentence.segment.length && s.end > sentence.index).map(s => s.id) }];
    });
  });
}
const grammatical = new Set('a an the i we you he she they it my our your his her their this that these those am is are was were be been being have has had do does did of on in at to for from by with as and or but so yeah okay ok very well good actually basically also team system app application'.split(' '));
const aliases: Record<string, string> = { initiated: 'start', initiate: 'start', commenced: 'start', commence: 'start', began: 'start', begun: 'start', begin: 'start', utilizes: 'use', utilize: 'use', utilized: 'use', utilises: 'use', using: 'use', running: 'run', references: 'links', reference: 'link', participants: 'speakers', participant: 'speaker', locally: 'local', done: 'complete' };
function tokens(text: string, speaker: string): string[] {
  const escaped = speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = text.replace(new RegExp(`\\b${escaped}\\b`, 'g'), 'I').toLowerCase()
    .replace(/tl;dr/gu, 'tldr').replace(/\b(i|we|you|they)['’]ll\b/gu, '$1 will').replace(/can['’]t/gu, 'can not').replace(/won['’]t/gu, 'will not').replace(/n['’]t/gu, ' not')
    .replace(/\b(?:i['’]m|we['’]re|it['’]s)\b/gu, ' ')
    .replace(/\blocal(?:ly)? on (?:the |this )?computer\b/gu, 'local');
  return (value.match(/[\p{L}\p{N}_]+/gu) ?? []).filter(word => !grammatical.has(word)).map(word => {
    word = aliases[word] ?? word;
    if (word.endsWith('ies')) word = word.slice(0, -3) + 'y';
    else if (word.length > 4 && word.endsWith('s')) word = word.slice(0, -1);
    if (word.length > 5 && word.endsWith('ing')) word = word.slice(0, -3);
    else if (word.length > 4 && word.endsWith('ed')) word = word.slice(0, -2);
    return word.endsWith('e') && word.length > 3 ? word.slice(0, -1) : word;
  });
}
export class UnsupportedSummaryRewrite extends Error {}
/** Conservative lexical support, not a semantic correctness score. Unverifiable rewrites use source wording. */
export function matchStatements(text: string, speaker: string, available: SourceStatement[], kind: string): SourceStatement[] {
  const output = tokens(text, speaker), remaining = new Map<string, number>();
  for (const word of output) remaining.set(word, (remaining.get(word) ?? 0) + 1);
  const matched: SourceStatement[] = [];
  for (const statement of [...available].sort((a, b) => tokens(b.text, speaker).length - tokens(a.text, speaker).length)) {
    const words = tokens(statement.text, speaker);
    if (!words.length) continue;
    const counts = new Map<string, number>();
    words.forEach(word => counts.set(word, (counts.get(word) ?? 0) + 1));
    if (![...counts].every(([word, count]) => (remaining.get(word) ?? 0) >= count)) continue;
    const critical = kind !== 'update' || /\d/u.test(statement.text) || words.some(word => ['no', 'not', 'never', 'if', 'unless', 'will', 'should', 'must', 'may', 'might', 'could', 'would', 'pending', 'provisional'].includes(word));
    if (critical && !output.some((_, start) => words.every((word, offset) => output[start + offset] === word))) continue;
    if (critical && /\bwe\b/iu.test(statement.text) && !/\b(?:we|team|group)\b/iu.test(text)) continue;
    const identifiers = [...statement.text.matchAll(/\b(?:branch|file|path|variable|function|ticket|issue)\s+([A-Za-z0-9_./:-]+)/giu)].map(match => match[1]!).filter(word => !grammatical.has(word.toLowerCase()));
    identifiers.push(...(statement.text.match(/`[^`]+`/gu) ?? []).map(word => word.slice(1, -1)));
    if (identifiers.some(identifier => !text.includes(identifier))) continue;
    const originals = statement.text.match(/\b[A-Z][A-Za-z0-9_]+\b/gu) ?? [];
    if (originals.some(word => !grammatical.has(word.toLowerCase()) && !['No', 'Not'].includes(word) && !text.includes(word))) continue;
    matched.push(statement);
    counts.forEach((count, word) => remaining.set(word, remaining.get(word)! - count));
  }
  if (!matched.length || [...remaining.values()].some(count => count !== 0)) throw new UnsupportedSummaryRewrite('Keep the complete original subject, action, conditions and values; avoid unsupported paraphrases');
  return matched;
}
export const statementKey = (statement: SourceStatement) => JSON.stringify([statement.speaker, statement.text.replace(/\s+/gu, ' ').trim()]);
