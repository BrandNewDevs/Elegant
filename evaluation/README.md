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

The default `gemma3:4b` tag was not installed. The explicitly selected installed tag is recorded rather than silently substituted. Real 5/10/20/60-minute Recordings and M4 measurements remain outstanding; no private examples are invented or committed.
