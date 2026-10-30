# TL;DR word-budget recovery

The `readable-summary-v12` schema required three selections when at least three points existed, while the application copied whole points and rejected totals over 90 words. Three valid 57-word points reproduced the reported 171-word failure. An individual point over 90 words could not be repaired by selecting fewer IDs either. The earlier fake models did not enforce the three-sentence schema, and the length regression expected rejection instead of successful recovery.

`readable-summary-v13` permits one to three sentences and asks for sentence text with validated point references. Supported shortening can omit filler and secondary detail while retaining original words and verb forms. Literal word order, values, ownership, negation, intent, conditional scope and identifiers are checked conservatively. A failed rewrite can fall back to its whole supported point when it fits; these checks are not a semantic correctness proof.

Application code packs complete supported sentences within 90 words and three sentences, prioritizing the latest explicitly affirmed final outcome, then significant status when it fits. Status-only responses are supplemented with complete supported main points within the same limits. It does not truncate sentences or change the full per-Participant Summary to satisfy the overview budget. Unsupported structured references still fail validation. Redundant inline numeric annotations are discarded; actual citations come only from validated references. Different supported sentences may share a point reference.

Unpunctuated independent clauses can be separated at an explicit new subject and predicate. Conditional and quoted scopes remain together. Original Transcript text and reference ordinals are preserved. Failed generation still preserves any previous Summary.

Production seam tests cover recovery from three 57-word selections, shortening a single oversized point, unpunctuated facts, status insertion, final decisions, reused evidence, ignored prose annotations and unknown structured references. They also reject altered polarity, ownership, verb tense, dates and conditional commitments, including dropping “yet” from unfinished testing or “only” from an English-only scope. The new synthetic `run-on-local-summary` fixture contains 158 words across three unpunctuated fragments and runs through the same production implementation as the app.

From the repository root, build and evaluate with the installed local Gemma tag:

```sh
pnpm --dir app run build
AI_MODEL=gemma3:4b-it-q4_K_M node app/dist/evaluation/cli.js summary evaluation/fixtures /tmp/summary-recovery.json
```

Review the resulting wording and citations against the original fixtures. Keep private replay fixtures and outputs outside Git. The earlier v12 comparison is historical; factual quality, native app behavior and M4 performance are separate checks. The screenshot alone does not supply the full new Mac Transcript for an exact replay.
