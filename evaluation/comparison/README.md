# Local comparison and remaining acceptance

All committed inputs and outputs here are synthetic. The device is the Linux i7-11800H laptop with approximately 16 GB RAM and an RTX 3050 Ti with 4 GB VRAM, running Ollama 0.34.0. These measurements do not establish M4 or Swift performance.

## Frozen baseline smoke

The identical three-segment input is `evaluation/baseline/smoke.json`. These runs use the frozen original summariser, context 8,192 and temperature zero. Its legacy output settings are retained; compare the final production pipeline separately.

| Model | Cold | Warm | Calls per run |
| --- | ---: | ---: | ---: |
| `gemma3:4b-it-q4_K_M` | 10.61 s | 5.82 s | 1 |
| `gemma4:e2b` | 14.73 s | 4.13 s | 1 |

Cold means all resident Ollama models were unloaded and `/api/ps` was verified empty. Warm is the immediate identical second run after verifying that model remained resident. OS file caches were not reset. See the JSON files for digests, quantization and hardware. Separate process/server memory was not sampled for these four runs.

Reproduce from the repository root after building the evaluation command:

```
ollama stop gemma3:4b-it-q4_K_M
ollama ps
AI_MODEL=gemma3:4b-it-q4_K_M node app/dist/evaluation/baseline-cli.js evaluation/baseline/smoke.json /tmp/baseline-cold.json
ollama ps
AI_MODEL=gemma3:4b-it-q4_K_M node app/dist/evaluation/baseline-cli.js evaluation/baseline/smoke.json /tmp/baseline-warm.json
```

Stop any other resident model too before calling the first run cold. Repeat with `gemma4:e2b` for the candidate. These commands write synthetic outputs; the original baseline CLI does not enforce private-file safeguards.

An implementation spot check found that the Gemma 3 warm baseline TL;DR suggests the launch date was deferred until tomorrow, while the source establishes only tomorrow's permission tests and explicitly says no date is agreed. This is a qualitative source inspection, not independent human scoring.

`gemma4-current-before-final-summary.json` is an exploratory production-v1 tuning observation: its per-Participant list omits Speaker 1's review commitment and uncertainty, while repeating You's points. It is retained as a failure observation. A quick response or valid JSON is not a quality pass.

## Earlier production-v2 short Summary comparison

The same `straightforward` fixture and production-v2 Summary prompt were used for both models, with 8,192 context tokens, 2,048 maximum output tokens, a 5,500-byte complete-request bound and temperature zero. Cold/warm model residency was controlled as above; background applications and OS caches were not controlled.

| Model | Cold | Warm | Calls per run | Sampled Ollama RSS peak, cold / warm |
| --- | ---: | ---: | ---: | ---: |
| Gemma 3 | 57.72 s | 48.36 s | 4 | 3.45 / 3.44 GiB |
| Gemma 4 e2b | 23.56 s | 16.23 s | 2 | 3.29 / 2.96 GiB |

The Gemma 3 runs preserved all four predefined critical points in the Participant list. Their optional refinement exhausted validation attempts and retained the valid initial draft; the extra calls are a latency cost. This spot check does not establish the full 90% gate. The candidate's cold output again omitted Speaker 1's points. Its warm output included both Participants, but the TL;DR cites refs 1/2/3 while mentioning the Thursday commitment established in ref 0. Faster output therefore does not pass the same quality requirements.

Resource JSON files retain sampled peaks, initial/peak/last swap, warnings and sample counts. Full time-series samples were omitted from the committed reports. RSS may count shared pages; GPU observations include the desktop and other processes, and swap includes earlier workload. Do not add these columns into a device-memory total.

## Long Summary deadline failure

`gemma3-long-default-deadline.json` records a failed production-v2 run of the synthetic long fixture: 900.0 seconds and 50 calls, with no partial Summary published. The first 29 extraction calls consumed most of the time; later bounded comparisons were still progressing when the deadline expired. This is a compute/latency failure on the laptop, not proof of a passed long-Meeting quality gate.

The associated resource report sampled 9.30 GiB peak Ollama process-tree RSS and 3,080 MiB NVIDIA usage. System swap began at 2.33 GiB, peaked near the full 4 GiB swap allocation and ended at 1.94 GiB. These observations include shared mappings and other applications; they are not unique physical-memory totals or M4 measurements. An extended evaluation deadline is used separately to inspect whether the algorithm completes and preserves the final decisions. It does not change the shipped 15-minute deadline or relax the M4 gate.

## Current short Summary comparison

`gemma3-short-summary-v16.json` and `gemma4-short-summary-v16.json` use the same clean source commit `4cc7100`, seven short fixtures and identical production settings, including thinking disabled. These are uncontrolled runs, not cold/warm or M4 measurements. They call the actual production Summary implementation.

| Model | Completed | Calls | Total for seven fixtures | Important / critical points represented on agent source review |
| --- | ---: | ---: | ---: | ---: |
| Gemma 3 | 7/7 | 9 | 97.16 s | 27/27 / 21/21 |
| Gemma 4 e2b | 7/7 | 8 | 26.02 s | 27/27 / 21/21 |

This is agent review against tuned synthetic fixtures, **not independent human review or a blind release gate**. Both runs retain the expected Participant attribution; no unsupported critical decision, owner or deadline was found. Gemma 3's inspected citations support its claims. Gemma 4's spoken-instructions introduction cites segment 2 instead of the exact source in segment 0; that noncritical mistake propagates into its TL;DR. Its disagreement refinement also leaks a draft marker. Gemma 3 can repeat a task in the TL;DR or omit another important point there even when the Participant list retains it. Keep Gemma 3 as the default; faster output alone does not clear the quality and M4 gates.

The TL;DR now selects whole existing claims and derives references rather than generating another factual paraphrase. Long reduction proposes related-topic groups; application checks retain changed identifiers, owners, deadlines, numbers, symbols, negation and qualifications. Uncertain paraphrases remain visible, so long outputs can be verbose. Earlier claims retain links to strictly later revision context without asserting an invented superseded status.

Resource reports omit full time-series samples but retain their counts. The sampled Ollama process-tree RSS peak was 5.28 GiB in both runs; sampling includes previous model residency and is not an isolated physical-memory measurement. NVIDIA peaks were 2,874 / 3,082 MiB. System swap peaked at 2.84 / 4.00 GiB respectively, including other applications and previous workload. Do not sum these figures or treat them as target-M4 observations.

## Current controlled short runs

These `*-current-*-v18.json` runs use the same four-segment `straightforward` fixture and source `e34a7d1`. Each model was verified unloaded before cold and resident before its immediate warm repeat. OS caches and background applications were not controlled. All four runs completed in one call; source inspection found no transferred search-test deadline in the selected whole-claim TL;DR. Short-path production logic is unchanged by the later long-extraction work.

| Model | Cold | Warm |
| --- | ---: | ---: |
| Gemma 3 | 16.74 s | 8.65 s |
| Gemma 4 e2b | 11.61 s | 1.65 s |

These successful short observations do not promote the candidate or establish long-Meeting/M4 gates. Per-run JSON records digests, quantization, settings, output and resource limitations.

## Chat verification

`gemma3-short-chat-v14.json` and `gemma3-long-chat-v14.json` are clean source `efd032f` production runs: 30 short questions and seven long questions, with no hard errors. Agent review against the tuned synthetic sources found all **25/25 answerable questions**, including **24/24 critical answerable questions**, answered with correct support. The other 12 questions produced nine explicit negative original quotations and three verification abstentions. No critical unsupported claim or cross-Meeting reference was observed. All 34 published quotation answers matched their cited original passages and speakers. This is source inspection, not a blind human acceptance gate.

Short answers took a median 1.41 seconds, with all seven declared follow-ups answered. Five long targeted lookups took 4.28–5.98 seconds; the broad final-plan scan completed in 74.47 seconds with the final decision at reference 180. Calendar-date fallback abstained after 72.87 seconds with incomplete/unverified review; it is not a completed broad answer. Maximum serialized requests were 2,516 / 5,260 bytes, below 5,500. These are laptop observations, not M4 measurements.

Some answers include unnecessary or repeated context: deletion discussion before the privacy-list deadline, a quoted malicious test before its test-owner answer, or guide-writing and review commitments together. Actual speaker labels and original qualifiers keep these facts separate, but the answers can be less direct. Source identity alone does not prove relevance.

`gemma3-short-chat-before-fragment-context.json` retains the earlier reviewer omission. Whole-fragment context fixes that omission. The active question follows evidence; one full-history intent rewrite can resolve a follow-up, then only user questions enter source selection, preventing earlier assistant detours from becoming evidence. The second model self-audit was removed after it rejected explicit negative evidence and accepted wrong passages. Passage selection now returns validated IDs only; malformed/unknown IDs remain failures, and incomplete consolidation cannot establish absence.

## Full long Summary verification

`gemma3-long-before-sentence-classification.json` completed within the normal production deadline: **673.40 seconds, 84 calls**, clean source `a741f12`. It nevertheless failed quality review: only **6/8 important points and 6/7 critical points** were represented. Extraction omitted the final PDF-failed/Markdown-passed result and the lack of an M4 peak measurement. The retained critical facts had correct attribution; long output remained verbose. This completed run is explicitly a failed quality observation.

Its sampled Ollama RSS peak was 9.64 GiB and NVIDIA usage peaked at 2,874 MiB. System swap began at 3.65 GiB, peaked at 3.86 GiB and ended at 3.62 GiB. These are sampled process-tree/system observations with shared mappings and other applications, not unique physical-memory totals or M4 performance.

Long extraction now requires a kind for **every original sentence**. Missing classifications fail validation; code owns unchanged wording, actual speakers and references. Only explicitly classified procedural material can be omitted. Topic grouping preserves all distinct original clauses, deduplicates conservative equivalent subsets and uses two bounded organizing rounds. A smaller development reproduction retained the two missing facts. `gemma3-long-before-shared-schema.json` records the next complete attempt: 520.22 seconds and the 128-call cap, with 90 classification calls, one revision call and 37 grouping calls before failure. No partial Summary was published. The schema repeated the same category enum per sentence, forcing small batches. A follow-up shared-schema diagnostic still spent substantial time returning sentence IDs; it was interrupted and is not a completed latency or quality result. The current response is an exact-length ordered kind array mapped to original sentences in code, without removing original text or allowing missing labels. `gemma3-long-before-compact-codes.json` records the full v22 attempt: 900.00 seconds and 91 calls before the 15-minute deadline, with no Summary published. Sentence classification consumed 549 seconds across 30 calls and 3,886 output tokens; grouping consumed 339 seconds across 59 calls. The remaining time was insufficient for final TL;DR selection. V23 keeps the seven semantic kinds and strict exact-length classification but encodes them as integer positions. Its full run is pending. None of these failures clears the long quality gate.

## Release status

Automated seam tests cover bounded requests, source identity, unknown IDs, queue cancellation, history isolation, restart interruption, replacement/deletion guards, IPC validation, renderer controls and citation navigation. These tests establish behavior with fake models, not factual correctness. Final-head app/native CI and final model observations are required before merging the last PR.

The private manifest still has no supplied recordings. Independent human-reviewed 90% coverage, every critical final decision and answer, the actual offline native flow, M4 latency, memory pressure, retained Swift-model measurements and the real 60-minute check remain pending. Use [the device checklist](../../docs/ai-testing.md), keep private references outside Git and record failed outcomes until fixed and rerun. The synthetic reserved cases were used during tuning and cannot be called blind final evaluation.
