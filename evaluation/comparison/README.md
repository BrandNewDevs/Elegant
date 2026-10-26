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

## Release status

Keep Gemma 3 as the default. One short comparison does not establish candidate superiority, and neither model has passed the agreed target-M4 gates here.

Automated seam tests cover request bounds, validation, source identity, queue cancellation, history isolation, restart interruption, replacement/deletion guards, IPC validation, renderer controls and citation navigation. Fake-model tests establish those behaviors; they do not establish generated factual correctness.

Independent human-reviewed 90% key-point coverage, every critical final decision, attribution and citation support remain pending. The four self-recorded Meetings are not available in this environment. No real 60-minute Recording, native offline flow, M4 latency, memory-pressure or retained Swift-model measurement is claimed. Use [the device checklist](../../docs/ai-testing.md), correct private references outside Git and retain failed outcomes until fixed and rerun.
