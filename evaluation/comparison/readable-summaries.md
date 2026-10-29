# Readable Summary comparison

## Scope and behavior

Production uses `readable-summary-v12`, Gemma 3 4B through local Ollama, temperature zero, an 8,192-token context, a 2,048-token maximum response and the unchanged 5,500-byte complete-request limit. The model tag is `gemma3:4b-it-q4_K_M`, digest `a2af6cc3eb7fa8be8504abaf9b04e88f17a119ec3f04a3addf55f92841195f5a`, with Ollama 0.34.0 on the Linux i7-11800H/16 GB/RTX 3050 Ti laptop. Loading conditions were not controlled as cold/warm benchmarks.

Adjacent same-speaker speech becomes working evidence without changing the stored Transcript. Extraction and consolidation validate speaker and original references, retain uncovered meaningful source statements, and reject unverifiable rewrites. A failed verification retains source wording or the preceding supported claims. This favors factual preservation over fluent compression; it does not establish semantic correctness.

The TL;DR step differs from unrestricted prose generation in the proposed plan: Gemma selects supported point IDs, and application code derives sentences and references. Each sentence selects one point. If a valid selection omits all significant explicit status points, the app inserts one supported status point, replacing the last selection when three slots are occupied, before checking the word limit. This prevents the TL;DR writer from inventing another factual paraphrase or joining unrelated points. Usually 40–70 words is a target; 90 words is a hard limit. At most three validated sentences are published.

Exact repeated complete evidence passages of at least 200 characters are extracted once with their latest references. Short and unfinished passages retain their occurrences. Critical facts and original references survive bounded consolidation; no partial Summary replaces a previously saved Summary after an error. Existing Summary fields and storage remain compatible without a migration.

Participant renames reject duplicate effective names, including the profile name. Existing collisions display the stable label alongside the name in the UI, chat and Markdown export. Grouping remains based on stable labels.

## Supplied private examples

Only operational metadata and aggregate review counts are committed in [the private metrics](gemma3-readable-v12-private-metrics.json). The supplied exports, replay fixtures, prompts and generated text remain outside Git. The full expected-point lists and unwanted-content criteria were finalized during early implementation, before final evaluation. These examples were used for tuning, not held out. Each example has seven expected important points, all designated critical, and each was run three times before and after the change.

| Example | Baseline median | Current median | Calls before → after | Points before → after | Current TL;DR words |
| --- | ---: | ---: | ---: | ---: | ---: |
| Private 1 | 32.61 s | 40.51 s | 12 → 5 | 24–25 → 12 | 31 |
| Private 2 | 19.39 s | 37.41 s | 6 → 5 | 3 → 6 | 57–67 |

Fewer calls did not mean lower latency. The new calls generate and check supported rewrites and a separate overview. Private 2 previously put many clauses into a few large points; increasing its point count is an improvement in separation, not added facts.

All three current repeats produced identical Participant points for each example. Private 1 produced one TL;DR variant; Private 2 produced two supported variants even at temperature zero. Agent source review found **7/7 expected points in each example on every repeat**, no unsupported critical claims and correct Participant attribution. Reference ordinal and speaker checks also passed for every point. Both TL;DRs cover the AI update and meaningful available testing status; they exclude the original hopes, generic acknowledgements and garbled closing phrases. The 31-word overview is shorter than the usual target for this short Meeting. These are source-review findings, not an independent human or blind evaluation.

The baseline had irrelevant hopes or garbled closing content in its TL;DRs. Baseline runs 2 and 3 recorded a changed checkout while still executing the same unrebuilt `grounded-summary-v24` compiled modules as clean-main run 1 (`5ab6ac4`). This limits exact source-metadata reproducibility; the baseline modules were not rebuilt until all three runs finished. Baseline quality counts are left unset rather than implying a separate complete semantic audit.

The Markdown inputs provide start timestamps, not segment ends; replay fixtures infer `end = start + 1 second`. Exported names are replay labels and do not establish original diarization correctness or recover ambiguous identities. This comparison does not test audio recognition, actual Mac boundaries or UI behavior on those Recordings.

## Synthetic evaluation

All **nine synthetic fixtures generated successfully**: the eight original fixtures and the new fragmented-status/noisy-ending regression. [The synthetic results](gemma3-readable-v12-synthetic.json) include output, timing and request metadata, without debug prompt traces. Agent source review found **38/38 expected points and 31/31 critical points**, correct attribution and no unsupported critical claims. Structural checks found no invalid or cross-speaker references. These counts describe factual coverage; they do not establish that paraphrased repetitions were consolidated well.

| Fixture | Seconds | Calls | Expected points covered |
| --- | ---: | ---: | ---: |
| ambiguous-ownership | 37.72 | 7 | 4/4 |
| changed-decision | 34.96 | 5 | 4/4 |
| disagreement | 40.73 | 7 | 4/4 |
| fragmented-status-update | 15.01 | 4 | 3/3 |
| long-discussion | 285.64 | 19 | 8/8 |
| proposal-versus-decision | 34.65 | 5 | 4/4 |
| repeated-points | 30.31 | 5 | 3/3 |
| spoken-instructions | 33.75 | 5 | 4/4 |
| straightforward | 26.42 | 5 | 4/4 |

The long synthetic Summary completed in **285.64 seconds and 19 calls**, within the unchanged 900-second deadline. The earlier recorded [v24 run](gemma3-long-summary-v24.json) took 476.17 seconds and 62 calls. This is an observation across uncontrolled laptop runs, not a controlled device-speed claim. The new output still contains **85 points and 1,131 words**, versus 69 points/about 1,140 words in v24. Individual sentences are separated more clearly, but overall long-Summary compression has not materially improved.

Development failures were retained as observations rather than successes: v8 reached the 900-second deadline after 45 calls; v11 generated eight cases but rejected the straightforward case after three TL;DR attempts omitted its unresolved release date. Exact repeated-evidence extraction reduced the long workload; v12 enforces significant supported status coverage in application code. All final requests stayed within 5,500 bytes (maximum 5,324 bytes). The largest reported synthetic prompt used 1,022 tokens, leaving room inside the 8,192-token context for the 2,048-token response budget.

## Acceptance status

Generation, source-coverage, critical-fact, attribution, reference, private TL;DR relevance and local deadline checks pass on the recorded examples. **Readability and paraphrase consolidation still need review; the PR remains a draft rather than claiming all quality goals are complete.** In particular, the repeated-task fixture still expresses the same task in several points, although it does not invent additional assignments.

## Verification and limits

After the recorded model runs, a seam test exposed a mixed segment containing both a request for updates and a commitment. Whole-segment housekeeping filtering now applies only to single sentences; individual sentences are filtered later. A before/after check found identical working evidence and source statements for all nine synthetic inputs and both private inputs, so the recorded model comparisons remain applicable. The new mixed-segment regression passes.

Final-head CI also exposed a Sonner exit-animation timer updating React after the renderer test window had been destroyed, despite all assertions passing. Renderer test cleanup now cancels timers created during each test after unmounting components; this changes no production UI behavior.

Local typechecking, the production build, **622 app/renderer tests across 42 files**, and **45 Python evaluation-tool tests** pass. The PR's app and native macOS CI checks also pass on the implementation and seam-test commits. Native CI runs Swift tests and engine integration; it does not measure an M4's app performance.

The strict verifier falls back frequently: four times per private Summary. It can reject valid paraphrases, retain conversational first-person wording, paraphrased repetition and occasional agreement acknowledgements among Participant points. Existing Transcript spellings remain unchanged. This improves the supplied results, but fluent concise paraphrasing and complete noise removal are still limitations. Structural checks and lexical support do not prove factual correctness; source review remains necessary.

Reserved synthetic examples were inspected during development. They are regression checks, not an untouched final holdout. The long fixture is synthetic and does not substitute for a real 60-minute Recording. No new real Recordings, original diarization review, independent human acceptance, actual M4 runtime/peak-memory/swap checks or native interactive app testing were performed in this environment.

Six system samples during development private replays observed approximately 9.1 GiB of Ollama runner RSS and a heavily used system swap file. These include shared mappings and unrelated applications; they are neither a full-run physical-memory peak nor an M4 measurement. Device performance remains a separate check.

Reproduce with the existing evaluation command after building the app:

```sh
AI_MODEL=gemma3:4b-it-q4_K_M node app/dist/evaluation/cli.js summary evaluation/fixtures /tmp/readable-synthetic.json
AI_MODEL=gemma3:4b-it-q4_K_M node app/dist/evaluation/cli.js private-summary /absolute/outside-repo/manifest.json /tmp/readable-private.json
python3 -m unittest discover -s evaluation -p 'test_*.py'
```

Repeat private mode three times using separate output paths. Keep private fixtures and generated outputs outside Git. Compare the results with prepared expected points and their original passages; do not count matching words as semantic acceptance.
