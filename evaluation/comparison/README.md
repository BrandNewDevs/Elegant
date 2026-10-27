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

## Production short Summary comparison

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

## Latest verification status (final PR still pending)

Summary v9 completed a fresh 30-segment development slice in 102.28 seconds and 22 calls. This is a synthetic tuning probe, not the full long fixture or a real 60-minute Meeting. Participant points represented all eight predefined important facts on source inspection, but the TL;DR added an unsupported broad statement about unresolved technical details. Earlier controlled v6 runs also incorrectly attached a guide-review deadline to completed search tests. These are failed faithfulness observations, not quality passes.

The fresh chat-v6 short suite completed all seven fixtures with two hard validation failures. Source inspection also found an incorrect answer to an unassigned task deadline, along with answerable questions returning verification limitations. Exact quote provenance checks do not establish answer relevance or factual correctness. Fixes and affected reruns remain required before the final PR is ready.

Summary v10 adds structurally validated labels for superseded claims with strictly later original references. Its focused tests pass; fresh model quality verification is pending. After the disposition additions, typechecking and all 489 app tests pass locally. The evaluation tools have 45 passing Python tests. Latest-head native CI and fresh model quality verification remain required.

## Release status

Keep Gemma 3 as the default. One short comparison does not establish candidate superiority, and neither model has passed the agreed target-M4 gates here.

Automated seam tests cover request bounds, validation, source identity, queue cancellation, history isolation, restart interruption, replacement/deletion guards, IPC validation, renderer controls and citation navigation. Fake-model tests establish those behaviors; they do not establish generated factual correctness.

At the final PR's initial code head, CI passed typechecking and production builds, 410 Node/renderer tests on Linux, 414 app/integration tests on macOS, 44 Swift tests and 33 Python tests. Later report-only changes still require the latest head's checks before merge.

Independent human-reviewed 90% key-point coverage, every critical final decision, attribution and citation support remain pending. The four self-recorded Meetings are not available in this environment. No real 60-minute Recording, native offline flow, M4 latency, memory-pressure or retained Swift-model measurement is claimed. Use [the device checklist](../../docs/ai-testing.md), correct private references outside Git and retain failed outcomes until fixed and rerun.
