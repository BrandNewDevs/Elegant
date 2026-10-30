import { isSummaryHousekeeping, type SummaryPassage } from './summary-passages.js';

export interface SourceStatement { speaker: string; text: string; sources: number[]; context?: string }
const bareAcknowledgement = /^(?:yes|yeah|sure|okay|ok|absolutely|understood)[.!\s]*$/iu;
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
    const spans = run.map(p => { const start = text.length; text += (text ? ' ' : '') + p.text; return { id: p.id, start, end: text.length, text: p.text }; });
    const boundaries = new Set([0, text.length]);
    for (const sentence of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) boundaries.add(sentence.index);
    for (const transition of text.matchAll(/\b(?:actually\s+)?I(?:['’]m| am) interested in\b/giu)) boundaries.add(transition.index!);
    const positions = [...boundaries].sort((a, b) => a - b);
    const statements = positions.slice(0, -1).flatMap((start, index) => independentClauses(text.slice(start, positions[index + 1]!)).flatMap(clause => {
      const value = clause.text.trim();
      if (!value || isSummaryHousekeeping(value) || bareAcknowledgement.test(value)) return [];
      const supporting = spans.filter(s => s.start < start + clause.end && s.end > start + clause.start);
      return [{ speaker: run[0]!.speaker, text: value, sources: supporting.map(s => s.id), context: supporting.map(s => s.text).join(' ') }];
    }));
    const joined: SourceStatement[] = [];
    for (const statement of statements) {
      const dependent = /^(?:(?:this|that|these|those|it) (?:is|are|was|were) (?:the )?(?:final|a suggestion|test outcomes|synthetic|quoted|not)|this call is one of|one of the tests|(?:do not|don't|don’t) infer (?:either|this|that)|(?:the )?(?:provisional|earlier|previous) plan is withdrawn)/iu.test(statement.text);
      const previous = joined.at(-1);
      const revision = previous && /\breplaces?\b/iu.test(statement.text)
        && tokens(statement.text, statement.speaker).filter(word => tokens(previous.text, previous.speaker).includes(word)).length >= 2;
      if ((dependent || revision) && previous) {
        const related = [joined.pop()!];
        while (joined.length && related[0]!.sources.some(id => statement.sources.includes(id))
          && joined.at(-1)!.sources.some(id => statement.sources.includes(id))) related.unshift(joined.pop()!);
        related.push(statement);
        joined.push({ speaker: statement.speaker, text: related.map(item => item.text).join(' '), sources: [...new Set(related.flatMap(item => item.sources))], context: related.map(item => item.context ?? item.text).join(' ') });
      } else joined.push(statement);
    }
    return joined;
  });
}
const grammatical = new Set('a an the i we you he she they it my our your his her their this that these those am is are was were be been being have has had do does did of on in at to for from by with as and or but so yeah okay ok very well good actually basically also team system app application'.split(' '));
const aliases: Record<string, string> = { initiated: 'start', initiate: 'start', commenced: 'start', commence: 'start', began: 'start', begun: 'start', begin: 'start', utilizes: 'use', utilize: 'use', utilized: 'use', utilises: 'use', using: 'use', running: 'run', references: 'links', reference: 'link', participants: 'speakers', participant: 'speaker', locally: 'local', done: 'complete' };
function tokens(text: string, speaker: string, normalizeInflection = true): string[] {
  const escaped = speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = text.replace(new RegExp(`\\b${escaped}\\b`, 'g'), 'I').toLowerCase()
    .replace(/tl;dr/gu, 'tldr').replace(/\b(i|we|you|they)['’]ll\b/gu, '$1 will').replace(/can['’]t/gu, 'can not').replace(/won['’]t/gu, 'will not').replace(/n['’]t/gu, ' not')
    .replace(/\b(?:i['’]m|we['’]re|it['’]s)\b/gu, ' ')
    .replace(/\blocal(?:ly)? on (?:the |this )?computer\b/gu, 'local');
  return (value.match(/[\p{L}\p{N}_]+/gu) ?? []).filter(word => !grammatical.has(word)).map(word => {
    if (!normalizeInflection) return word;
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
export const statementKey = (statement: SourceStatement) => JSON.stringify([statement.speaker, statement.text.replace(/\s+/gu, ' ').trim(), /\b(?:i|we|you|it|this|that|these|those|they|them|its|their)\b/iu.test(statement.text) ? statement.context ?? statement.sources.join(',') : '']);

/** Split only explicit new subjects; keep conditional and quoted scopes intact. */
function independentClauses(text: string): { text: string; start: number; end: number }[] {
  const clauses: { text: string; start: number; end: number }[] = [];
  let start = 0;
  const joins = /\b(?:and|but|also)\s+((?:I|we|it|they|the app|our app|the team)\s+(?:am|are|is|was|were|have|has|had|will|would|can|could|should|must|may|might|use|uses|run|runs|record|records|create|creates|produce|produces|support|supports|need|needs|want|wants|plan|plans|hope|hopes|prefer|suggest|propose|think|try|tries|started|finished|completed|test|tested|review|write)\b)/giu;
  for (const match of text.matchAll(joins)) {
    const preceding = text.slice(start, match.index);
    if (!preceding.trim() || hasProtectedScope(preceding)) continue;
    clauses.push({ text: preceding, start, end: match.index! });
    start = match.index! + match[0].length - match[1]!.length;
  }
  clauses.push({ text: text.slice(start), start, end: text.length });
  return clauses;
}

/** Allow omission for an overview, not new content or changed critical qualifiers. */
export function assertSupportedCompression(text: string, speaker: string, atoms: SourceStatement[]): void {
  const source = atoms.map(atom => atom.text).join(' ');
  const original = tokens(source, speaker), output = tokens(text, speaker);
  const literalSource = tokens(source, speaker, false), literalOutput = tokens(text, speaker, false);
  let position = 0, lastMatched = -1;
  for (const word of literalOutput) {
    while (position < literalSource.length && literalSource[position] !== word) position++;
    if (position >= literalSource.length) throw new UnsupportedSummaryRewrite('Use supported source wording in its original order');
    lastMatched = position++;
  }
  if (!output.length) throw new UnsupportedSummaryRewrite('Keep a substantive supported fact');
  // A condition's meaning depends on its full antecedent, not just the word "if".
  if (hasProtectedScope(source)) matchStatements(text, speaker, atoms, 'commitment');
  const hard = new Set(tokens('no not never yet only without can will would should must may might could cannot pending unassigned undecided provisional initial trying maybe likely possible potential uncertain', speaker));
  const qualifiers = new Set(tokens('propose suggest prefer consider think believe estimate expect hope plan going start continue ongoing unfinished incomplete say said report told quoted hypothetical commit intend agree approve reject decline fail pass complete finish cancel withdraw replace', speaker));
  // Later descriptive details can be omitted. Preserve action/intent qualifiers
  // leading into selected content, and hard polarity throughout its source context.
  const actorIntent = new Set([...source.matchAll(/\b(?:I|we|you|they|he|she|it|the app|our app|the team|our team)\s+(?:(?:am|are|is|was|were|will|would|could|might|still|currently|also|only|just)\s+){0,3}(want\w*|wish\w*|lik\w*)\b/giu)].flatMap(match => tokens(match[1]!, speaker)));
  const required = original.filter((word, index) => hard.has(word) || index <= lastMatched && (qualifiers.has(word) || actorIntent.has(word)) || /\d/u.test(word));
  const names = source.match(/\b[A-Z][A-Za-z0-9_]+\b/gu) ?? [];
  for (const name of names) if (!grammatical.has(name.toLowerCase())) required.push(...tokens(name, speaker));
  if (required.some(word => !output.includes(word))) throw new UnsupportedSummaryRewrite('Preserve names, values, status, uncertainty and negation');
  const escaped = speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/\b(?:I|my)\b/iu.test(source) && !new RegExp(`\\b(?:I|my|${escaped})\\b`, 'iu').test(text)) throw new UnsupportedSummaryRewrite('Preserve the stated owner');
  if (/\b(?:we|our)\b/iu.test(source) && !/\b(?:we|our|team|group)\b/iu.test(text)) throw new UnsupportedSummaryRewrite('Do not assign collective work to an individual');
  const identifiers = [...source.matchAll(/\b(?:branch|file|path|variable|function|ticket|issue)\s+([A-Za-z0-9_./:-]+)/giu)].map(match => match[1]!);
  if (identifiers.some(id => !grammatical.has(id.toLowerCase()) && !text.includes(id))) throw new UnsupportedSummaryRewrite('Preserve case-sensitive identifiers');
}

function hasProtectedScope(text: string): boolean {
  return /["“”]|\b(?:if|unless|provided|until|assuming|either|neither|subject to|when|whether|quoted|hypothetical|test material|test sentence|not authorized|not a decision)\b/iu.test(text)
    || /\b(?:will|would|should|can|could|may|might|must|commit\w*|intend\w*|plan\w*|hop\w*)\b[\s\S]*\b(?:after|before|once|as soon as)\b/iu.test(text);
}
