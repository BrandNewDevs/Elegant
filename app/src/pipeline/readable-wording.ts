/** Small, auditable equivalences used by both validation and presentation.
 * Never remove uncertainty/intent ("I think", "may", "only"), change actors or
 * shorten a condition. Quoted speech and code/identifier passages stay literal.
 */
export function readableWording(text: string): string {
  const value = text.trim();
  if (/\b(?:Utilize|Utilizes|Utilized)\b/u.test(value) || /["“”`]|\b(?:branch|file|path|variable|function|ticket|issue)\s+\S+/iu.test(value)) return value;
  const cleaned = value
    .replace(/^(?:(?:um|uh|okay|ok|well|so),\s*)+/iu, '')
    .replace(/^(?:as I mentioned earlier|to repeat|repeating my earlier commitment):?[,\s]+/iu, '')
    .replace(/^to repeat my only assignment:\s*/iu, 'My only assignment: ')
    .replace(/\bin order to\b/gu, 'to')
    .replace(/\bdue to the fact that\b/gu, 'because')
    .replace(/^At the present time\b/u, 'Currently')
    .replace(/\bat the present time\b/gu, 'currently')
    .replace(/\bon a (daily|weekly|monthly) basis\b/gu, '$1')
    .replace(/\bmake use of\b/gu, 'use')
    .replace(/\bmakes use of\b/gu, 'uses')
    .replace(/\b(I|we|you|they|the app|our app|the system) (utilize|utilizes|utilized)\b/giu, (_, subject: string, verb: string) => `${subject} ${{ utilize: 'use', utilizes: 'uses', utilized: 'used' }[verb.toLowerCase()]}`);
  // Keep a standalone acknowledgement when there is no remaining statement.
  if (!cleaned.trim()) return value;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
