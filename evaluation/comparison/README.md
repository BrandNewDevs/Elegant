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

The TL;DR now selects whole existing claims and derives references rather than generating another factual paraphrase. Long reduction proposes SAME-CLAIM equivalents; application checks retain changed identifiers, owners, deadlines, numbers, symbols, negation and qualifications. Uncertain paraphrases remain visible, so long outputs can be verbose. Earlier claims retain links to strictly later revision context without asserting an invented superseded status.

Resource reports omit full time-series samples but retain their counts. The sampled Ollama process-tree RSS peak was 5.28 GiB in both runs; sampling includes previous model residency and is not an isolated physical-memory measurement. NVIDIA peaks were 2,874 / 3,082 MiB. System swap peaked at 2.84 / 4.00 GiB respectively, including other applications and previous workload. Do not sum these figures or treat them as target-M4 observations.

## Chat verification

`gemma3-short-chat-before-fragment-context.json` records an actual chat-v12 run: all 30 short-fixture questions completed without hard errors in 40 model calls. Source inspection found that the reviewer answer selected the negative writing sentence while omitting the affirmative review commitment immediately before it. It is retained as a failed quality observation, not a passed chat gate.

Chat now publishes the whole original fragment containing a selected canonical sentence, with its actual speaker and derived citations. This preserves neighboring commitments and qualifiers. The active question follows the evidence in the model request. A failed follow-up rewrite retains the original two user questions as intent context instead of guessing a subject. A second model self-audit was removed because actual runs showed it rejected explicit negative evidence and rubber-stamped wrong passages. Canonical wording establishes provenance, not semantic relevance; final source review remains necessary.

The latest whole-fragment chat run and full synthetic long Summary are pending. Earlier failed runs remain versioned above. No incomplete result, cached replay or small development slice is a real 60-minute or successful production-latency measurement.

## Release status

Automated seam tests cover bounded requests, source identity, unknown IDs, queue cancellation, history isolation, restart interruption, replacement/deletion guards, IPC validation, renderer controls and citation navigation. These tests establish behavior with fake models, not factual correctness. Final-head app/native CI and final model observations are required before merging the last PR.

The private manifest still has no supplied recordings. Independent human-reviewed 90% coverage, every critical final decision and answer, the actual offline native flow, M4 latency, memory pressure, retained Swift-model measurements and the real 60-minute check remain pending. Use [the device checklist](../../docs/ai-testing.md), keep private references outside Git and record failed outcomes until fixed and rerun. The synthetic reserved cases were used during tuning and cannot be called blind final evaluation.
