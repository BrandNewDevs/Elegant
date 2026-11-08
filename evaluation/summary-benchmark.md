# Human-reviewed Summary benchmark

This benchmark measures the production Summary output against original Transcript evidence. It does not change generation, call a model, or certify speech recognition. The legacy `report.py` command remains available for historical Summary/chat reports; use `summary_benchmark.py` for version 1 of this rubric.

## Prepare expectations

Use the existing fixture format and production `eval:ai summary` runner in [the evaluation guide](README.md). Before generating output, a human must prepare non-empty important points with stable IDs, actual speaker labels, supporting segment ordinals and critical flags. Mark decisions, commitments and ownership critical where an error would materially mislead a reader. Record conditions and unresolved status in expected point text. Expectations describe meaning, not mandatory wording. `tldrTopics` and `unwantedContent` can provide additional review guidance. Do not pass expectations into generation.

The ten committed synthetic cases cover ordinary discussion, proposals, changed decisions, ownership ambiguity, disagreement, repetition, spoken instructions, long discussion, fragmented speech and unpunctuated passages. Review their expectations before adopting a benchmark version. They have already been visible during development and are regression examples, not blind holdouts.

Keep real Recordings, Transcripts, prepared expectations and content-bearing review files outside Git. Follow [private export](../docs/ai-testing.md). Use the private 5/20-minute examples for tuning and 10/60-minute examples for reserved evaluation. These examples remain pending until actually recorded and reviewed. Preserve the original model Transcript; corrected audio references are a separate speech evaluation.

## Review a run

Select a fixture directory containing exactly the examples in the result file. For private examples, use a private directory containing prepared fixtures only. Store results and reviews in an existing private directory outside the repository.

```sh
python3 evaluation/summary_benchmark.py prepare /private/results.json \
  --fixtures /private/selected-fixtures --output /private/review.json
```

The command creates an incomplete review, never a fabricated human judgment. It refuses to overwrite files and creates owner-only files. Each binding fingerprints the full fixture, generated run and run metadata. Changed output, expectations or metadata require a new review. Fingerprints detect accidental stale reuse; they do not authenticate a reviewer or conceal low-entropy source content.

Read the entire original Transcript, then inspect every generated claim and its citations. Fill in reviewer, review date, coverage judgments and evidence notes for every expected point. In notes, identify the generated point (for example `participants[0].said[1]`) and source segment ordinals; explain omissions. Judge the final outcome in `criticalDecisionsCovered` explicitly, including when no final decision was made.

Rate every dimension from 1 to 3 and give a rationale:

| Dimension | 1 | 2 | 3 |
| --- | --- | --- | --- |
| factualSupport | Material unsupported claim | Minor unsupported meaning | All claims supported |
| attribution | Wrong owner or speaker | Attribution ambiguous | All attribution correct |
| conditions | Material qualification lost | Minor uncertainty weakened | Negation, intent and conditions preserved |
| readability | Hard to understand | Understandable but verbose or awkward | Clear, concise standalone prose |
| repetition | Repetition obscures meaning | Some redundant points | No unnecessary repetition |
| tldrUsefulness | Misleading or misses main outcome | Useful but uneven | Balanced important outcomes, next steps and unresolved status |

A fluent invented commitment scores poorly on facts regardless of readability. A conditional proposal must not become an agreement. An exact quotation may still mislead if a later correction supersedes it. Different supported wording is acceptable.

Record failures in `findings`: kind (`unsupportedClaim`, `ownership`, `invalidReference`, `citationSupport`, or `other`), critical boolean, output location, source evidence and explanation. For absent support, explain the relevant reviewed context rather than inventing a source reference. These notes are private content; the scored report includes counts, not notes or Transcript text.

Set `complete` to true only after reviewing all fields. Generate the report:

```sh
python3 evaluation/summary_benchmark.py score /private/results.json \
  --fixtures /private/selected-fixtures --reviews /private/review.json \
  --output /private/scored.json
```

## Interpret results

A factual pass requires at least 90% expected-point coverage, every critical point and final decision, scores of 3 for factual support/attribution/conditions, and no ownership, invalid-reference, citation-support or critical unsupported-claim findings. Presentation scores are reported separately without an uncalibrated acceptance threshold. Missing human review remains pending; malformed generation and invented labels fail even without review. Chat is outside this benchmark.

Inspect per-example results and split/synthetic flags rather than treating one combined status as real-Meeting acceptance. Metadata is retained, so keep private reports outside Git too. No benchmark score establishes M4 latency, native operation or audio accuracy.

For initial calibration, two humans independently review the same small subset and reconcile disagreements against the Transcript. Save separate review files and document reconciled judgments; do not average factual disagreements away. Freeze fixture/rubric versions and record code/model metadata before comparison. Repeat a subset of model runs to observe variability, creating new bound reviews for each run.

Run reserved examples after tuning is fixed. If a reserved failure informs further tuning, record that exposure and obtain fresh reserved examples for subsequent independent acceptance. Report unperformed reviews as pending. Closing the tooling issue does not mean the summarizer passes: actual reviewed baseline results must be collected by humans.
