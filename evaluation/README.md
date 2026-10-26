# Local AI evaluation

Production AI is TypeScript. Python is only for analysis; it is never bundled with the app. Use synthetic Transcripts in Git. Keep real Recordings, corrected Transcripts and generated reports containing their words outside this repository.

## Reproduce the frozen baseline

From `app/`, after `pnpm install`:

```
AI_MODEL=gemma3:4b-it-q4_K_M pnpm run eval:baseline ../evaluation/baseline/smoke.json /tmp/baseline.json
```

The runner calls the original public Summary implementation frozen from `1ee9d82`, through the real Ollama adapter. It records tag, digest, quantization, Ollama version, settings, prompt version, hardware, elapsed time and call count. Use a fresh Ollama process to measure cold loading; a second run measures warm behavior. Node peak RSS excludes Ollama and the Swift engine.

## Initial observation

`baseline/linux-smoke.json` is a real local-model run on a synthetic three-segment discussion. It took 13.0 seconds and one call. The model retained the unresolved launch date and attributed the test commitment correctly. This is a smoke observation, not a quality evaluation or an M4 performance result. Cold versus warm was not controlled.

At `1ee9d82`, typechecking and the production app build passed on Linux. App and renderer tests: 209 passed. The three native-engine integration tests require the built macOS engine and fail here; `pnpm test` stops at `swift: not found`. They are now a distinct Vitest project, still included by `pnpm test`. CI runs them on macOS, with app tests separately on Linux.

The first macOS CI run also exposed a pre-existing Swift type-check timeout in the WAV header expression. Splitting the expression preserves its bytes and makes the compiler work bounded.

The default `gemma3:4b` tag was not installed. The explicitly selected installed tag is recorded rather than silently substituted. Real 5/10/20/60-minute Recordings and M4 measurements remain outstanding; no private examples are invented or committed.

## Evaluation examples

`fixtures/` contains eight entirely synthetic Transcripts with expected important points, source references and questions: straightforward discussion, proposal versus decision, changed decision, ambiguous ownership, disagreement, repetition, spoken misleading instructions and a long discussion. The long fixture contains over 50,000 characters and constructed timestamps covering 60 minutes. It is not an audio Recording or evidence that a real 60-minute workflow passes.

Fixtures use this shared shape:

- `id`, `split` (`tuning` or `reserved`) and `synthetic`.
- `transcript.segments`: ordered `{start, end, speaker, text}` entries.
- `points`: `{id, text, speaker, refs, critical}` expectations.
- `questions`: `{id, question, answer, refs, critical}`, optionally `followUpTo` naming an earlier question ID. A null expected answer means the requested fact is not established. References can point to explicit uncertainty; an empty list means the fact is absent entirely.

Fixture `refs` are zero-based segment ordinals, not database IDs. Answers and expected points describe meaning, not exact required wording. Review final decisions and unsupported claims manually; matching words alone cannot establish faithfulness. Evaluate reserved fixtures only after tuning decisions are fixed, and report any subsequent tuning against them.

## Private Recordings and corrected references

Copy `private-manifest.example.json` outside the repository and fill in paths only after creating the examples. Its four examples are pending, not recorded or evaluated. `path` must point to a private fixture JSON with the same shape above and `synthetic: false`; it does not point directly to audio. Keep both that fixture and the filled manifest outside Git.

On the Mac, record approximately 5-, 10-, 20- and 60-minute Meetings with people who agree to be recorded. Run each through the actual app, then export its ordered Transcript segments to the fixture's Transcript JSON shape. The current Markdown export is not a JSON fixture; copy the structured Transcript through local tooling rather than treating Markdown as machine-readable fixture input. Do not upload it to a cloud tool. The real audio-to-Transcript end-to-end checks remain pending until run on the Mac.

Use 5 and 20 minutes for tuning, and reserve 10 and 60 minutes for final evaluation. For every example, add expected points, critical decisions, supporting segment ordinals, answerable questions, absent-answer questions and contextual follow-ups. Hand-correct representative excerpts for recognition and speaker attribution scoring, and review all passages supporting critical decisions. Do not overwrite the original model Transcript with the corrected reference: retain both privately so errors can be measured.

Commit only synthetic fixtures, tooling and reports that contain no private content. Do not commit filled manifests with private paths, Recordings, real people's Transcripts, or generated answers derived from them.
