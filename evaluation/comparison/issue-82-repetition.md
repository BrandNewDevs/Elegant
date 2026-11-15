# Summary repetition: issue #82

Paired production-pipeline evaluation on four existing synthetic fixtures, using
local `gemma3:4b-it-q4_K_M`, the same model digest, temperature zero and default
request/deadline settings. Baseline: `b9f30982bfa9240ecfe85bc87f62c49fe3c2c1f2`
(readable-summary-v19). Candidate: `ce81cca0585c8fc5ef34489071aef723ef305b8f`
(readable-summary-v20). Both source snapshots were clean. The adjacent JSON keeps
metadata, complete generated Summaries, evidence, request observations and timings.
Only synthetic content is included.

## Agent source review

| Fixture | Observation | Requests before → after |
| --- | --- | --- |
| repeated-points | Participant points decrease from 10 to 8. The two full permission-test promises become one qualified promise citing 0 and 2; export-review promises become one citing 1 and 3. The TL;DR includes each commitment once and uses its third sentence to distinguish Friday's review from the release date. Unset release status remains in Participant points. | 5 → 5 |
| ambiguous-ownership | Same output: unassigned guide, absent deadline, conditional review and refusal to accept ownership remain distinct. | 7 → 7 |
| changed-decision | Earlier positions remain historical; final Friday/Markdown decisions and Wednesday retest survive. Unset calendar date stays in Participant points. TL;DR selects the failed offline test instead of the calendar-date caveat in this run. | 5 → 7 |
| disagreement | Opposing retention preferences and the absence of agreement survive in Participant points. TL;DR selects the agreement to review the tradeoff list instead of explicitly stating the unresolved default. | 7 → 7 |

Verdict: the targeted duplicate commitments and repeated TL;DR promise improve
without losing distinct facts from the full Summary. This is not a claim that all
repetition is solved or that overview selection universally improves. The abbreviated
“The permission test remains my Thursday task” and explicit task-count statements
remain: the conservative relation does not infer arbitrary referential equivalence.
Broader discourse deduplication and TL;DR prioritization still require evaluation.

This is agent inspection, not the human-reviewed benchmark gate. Runtime was
uncontrolled on Linux (i7-11800H, RTX 3050 Ti 4 GB, 16 GB RAM), including model-load
variation; timings do not establish a performance gain or Apple M4 acceptance.
No real Transcripts or live Gemini requests were used.

## Automated validation

- 881 app/renderer tests pass, including 19 new production-seam repetition cases.
- 55 Python evaluation tests pass.
- Typechecking and production build pass.
- Cases include fronted deadlines, contractions, action-noun paraphrases, no-deadline
  commitments, exclusive assignment qualifiers in both orders, changed owner/action/
  object/deadline/modality/negation, contextual pronouns, renewed commitments after
  cancellation, separate Participants, 60 mentions across extraction batches, and
  Gemini draft/final/TL;DR repetition with retained evidence.
- Existing tests preserve distinct TL;DR facts sharing one point ID, decision history,
  cross-Participant responses and semantic safeguards.
- Native Swift checks run separately on macOS CI; Linux tests do not validate native
  Recording behavior or real-Meeting Summary quality.

Reproduction (copy the four named fixtures to a temporary directory first):

```sh
pnpm --dir app exec tsc -p tsconfig.build.json
AI_SYNTHETIC_TRACE=1 AI_MODEL=gemma3:4b-it-q4_K_M \
  node app/dist/evaluation/cli.js summary /tmp/elegant-82/fixtures /tmp/elegant-82/results.json
```

Raw synthetic diagnostic traces were retained outside Git in
`/tmp/elegant-82/before.json` and `/tmp/elegant-82/final.json` for this run; the
committed comparison excludes their redundant prompts and responses.
