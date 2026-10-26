# AI pipeline brief

For whoever builds the AI side. Read [`design.md`](./design.md) and [`GLOSSARY.md`](../GLOSSARY.md) first, and the two ADRs in [`docs/adr/`](./adr/).

## What you own

1. **Summarisation, fully.** The prompts, how long Meetings are chunked, the "what each Participant said" output, and a way to judge quality.
2. **Meeting chat.** Answer questions about one selected Meeting, with supporting Transcript references and locally persisted history.
3. **Transcription and diarization model evaluation.** Measure recognition and attribution errors and recommend models with an Apple Silicon route.

Production AI logic lives in the Electron app's TypeScript pipeline. Swift owns transcription and diarization. Ollama serves Gemma. Python only collects evaluation results and calculates metrics; it is not a production runtime. Evaluation must invoke the same TypeScript modules as the app, not a separate Python implementation.

The delivery order is evidence-backed Summaries, then Meeting chat. English Meetings up to 60 minutes are the initial target. Evidence-backed Summary generation and its supporting request infrastructure are implemented. Meeting chat and citation navigation in the UI remain upcoming work. Quality and target-device gates below remain unverified until their evaluations are completed.

## What you can and can't conclude from Linux

Linux can exercise Summary and chat logic and provide development measurements. It does not establish the accuracy or performance of the actual Swift audio implementation. The target machine is a 16 GB Apple M4. So:

- Report accuracy, model size and memory observations, naming the implementation and device. Keep Linux timings separate from M4 acceptance measurements.
- Recommend only models that fit the M4: transcription and summarisation run one after the other, and each should stay under roughly 8 GB so there is room for the OS and the app.
- Whatever you recommend must have an Apple Silicon route (for example WhisperKit, whisper.cpp, MLX, or Core ML), or be clearly marked as not portable.

## Constraints

- **Fully local, open-weight only.** Nothing may call a cloud API ([ADR 0002](./adr/0002-fully-local-processing.md)). Summaries use models served by Ollama; the default is `gemma3:4b`.
- **English only.**
- **Transcription runs after the Meeting, in one batch.** Live or streaming transcription is out of scope.

## The two stages

They are separate so Summary generation can be developed without audio. Preserve the Swift Transcript wire format and the existing user-facing Summary fields. Add evidence and generation metadata alongside the Summary in TypeScript and storage.

### Stage 1: audio to Transcript

Input: two WAV files, 16 kHz mono, starting at the same instant and the same length. The capture engine aligns the raw tracks by host time before handing them over (they start about 0.2 s apart as recorded), so you can treat them as already aligned.
- `mic.wav`: you.
- `system.wav`: everyone else, as one blended track.

Output: a Transcript as JSON.

```json
{
  "segments": [
    { "start": 12.3, "end": 15.8, "speaker": "You", "text": "..." },
    { "start": 16.1, "end": 20.4, "speaker": "Speaker 1", "text": "..." }
  ]
}
```

- Everything on `mic.wav` is labelled `You`.
- `system.wav` needs diarization. Its voices are labelled `Speaker 1`, `Speaker 2`, and so on. Labels are stable within one Meeting.
- Segments are ordered by `start`. Overlapping speech is allowed.

### Stage 2: Transcript to Summary

Input: the Transcript JSON above, with nothing else. Any Transcript will do, including ones from public sources.

Output: a Summary as JSON.

```json
{
  "tldr": "...",
  "participants": [
    { "speaker": "Speaker 1", "said": ["...", "..."] }
  ]
}
```

- `speaker` must be exactly a label from the Transcript. The app swaps in real names after the user renames a Participant, so the Summary must never invent or guess names.
- `said` holds the points that Participant made, not a quote of everything.
- Nothing may appear in the Summary that is not in the Transcript.

## Evidence and generation contract

- Compute a fingerprint from ordered segment content. References use segment ordinals within that revision; resolve them to timestamps and speaker labels in application code. A reference is valid only for its associated revision. The Swift wire format stays unchanged.
- Keep `Summary.tldr` and `Summary.participants[].said` compatible. Store supporting references per TL;DR and point, plus revision and generation metadata, alongside those fields. Save replacements atomically. Failed regeneration preserves the previous Summary and evidence. Legacy Summaries remain readable without evidence.
- Reject unknown speaker labels, unknown references, duplicate Participant entries, blank points and malformed output. Per-Participant evidence must include that Participant's speech. These checks establish structure, not factual support.
- Short Transcripts use one bounded request. Long Transcripts use extraction, then bounded consolidation with original source passages and references. Preserve proposals, commitments, disagreement, unresolved matters and later corrections. Never silently truncate or publish an incomplete result as complete.
- Start with 8,192 context tokens, at most 2,048 response tokens and a conservative 5,500 UTF-8 byte serialized-input budget. Count instructions, evidence, history and retry messages together; check the margin against actual prompt-token counts. Use temperature zero and at most three total attempts for invalid output. Connection errors are actionable failures, not blind retries.
- Centralize model settings and readiness checks. Support system/user messages, JSON Schema, timeouts, cancellation and operational metadata without logging Transcript content or prompts by default. Serialize AI jobs, release idle speech models before Gemma and cancel work before closing storage.

## Shared infrastructure now implemented

`pipeline/evidence.ts` computes ordered Transcript revisions and resolves segment ordinals, rejecting stale references. `OllamaClient.complete` supports system/user messages, schema output, bounded requests, cancellation through body reading, timeouts and token/timing metadata. `generate` remains the compatibility adapter. The frozen evaluation baseline has its own original transport and validator.

`AppCore.jobs` serializes pipeline work; Settings model preparation shares that queue. Cancelling an active job keeps its resource slot occupied until the underlying work settles. Shutdown cancels jobs, stops the engine, waits for work to settle, then closes storage. Successful transcription waits for `models_released` before returning; preparation unloads models too. Mac memory measurements remain pending. Queue display and user controls arrive with the UI integration.

## Evidence-backed Summary implementation

The public `createGroundedSummariser` interface in `pipeline/grounded-summariser.ts` implements the Summary contract. The app and evaluation runner use it; the frozen original summariser remains available only for comparison. It returns the compatible Summary fields with optional `evidence` and `generation` sidecars.

`evidence` contains the Transcript `revision`, TL;DR segment ordinals in `tldr`, and per-Participant `said` reference lists aligned with the existing Summary points. `generation` records prompt version, model, elapsed time, request count and available token counts. Speaker labels remain stable internally; Participant renames affect presentation only.

Short inputs are summarized in one request. Larger inputs use bounded extraction and consolidation while preserving original segment references and relevant source text. Structural validation rejects unknown labels and references, duplicate Participants and empty points; factual accuracy still requires review. Empty Transcripts complete without a Summary. Failed regeneration leaves the last successful Summary and sidecars intact.

The additive schema version 3 migration creates `summary_artifacts`, `chat_requests`, `passages` and `passage_index`. Summary artifacts are wired now and saved atomically with Summary text. The chat and passage tables establish storage for later deliveries; they do not mean chat or retrieval is already available. Existing version 2 data and legacy Summaries without artifacts remain readable; regeneration adds evidence.

Clickable evidence references will be added in the later UI delivery. Until then, stored references and evaluation output can be inspected through application interfaces. Passing structural tests is not a claim that the human-reviewed Summary quality or M4 performance gates have passed.

## Planned Meeting chat contract

Chat becomes available once a Meeting's Transcript is complete, even if Summary generation failed. Each answer contains text, supporting references and an evidence-sufficiency result. Facts come from the original Transcript, never from earlier generated answers. Missing owners, dates and agreements must not be guessed.

Use the full Transcript when it fits; otherwise use Meeting- and revision-scoped passage FTS5 retrieval, neighbors and chronological evidence. Allow one bounded query rewrite for empty lookup or a follow-up. Broad or insufficient lookup scans all passages in bounded batches; an interrupted scan cannot claim an exhaustive answer.

Persist the full visible history per Meeting. Send only the latest four completed exchanges, dropping oldest context first to fit the request budget. Store statuses, references, revision and model metadata. Failed, cancelled and interrupted requests remain distinct; restart marks unfinished work interrupted. Clearing chat or deleting a Meeting cancels related work before removing records. Late results must not recreate it. Transcript replacement clears chat and derived evidence; renames and Summary regeneration preserve it.

The React UI uses typed, sender-checked preload IPC. Questions are limited to 2,000 characters. Generated content is escaped text, and only completed validated answers are displayed. Citations open the corresponding Transcript segments without audio. Chat export and token streaming are deferred.

## Evaluation and acceptance

Preserve the current summariser as a frozen baseline through its public interface. Record model name, digest, quantization, Ollama version, context settings, prompt version, hardware, latency and model-call count for each run. Compare `gemma3:4b` against at most `gemma4:e2b`; retain the baseline unless the candidate passes the same gates and improves measured results.

Use eight committed synthetic fixtures: straightforward discussion, proposal versus decision, changed decision, ambiguous ownership, disagreement, repetition, spoken misleading instructions and a long discussion. Keep four self-recorded examples outside Git: approximately 5 and 20 minutes for tuning, 10 and 60 minutes reserved for final evaluation. Synthetic length is not a substitute for a real 60-minute check.

Each example needs expected important points, critical final decisions, attribution and evidence, answerable and absent-answer questions, and follow-ups. Correct representative real Transcript excerpts for word error rate and speaker attribution, and review every passage supporting an expected critical decision.

- **Summary quality:** no invented labels or invalid references, no critical unsupported decisions or ownership, at least 90% expected important-point coverage and every expected critical final decision represented.
- **Chat quality:** no unsupported critical claims or cross-Meeting evidence; all predefined answerable critical questions answered correctly with support. Record retrieval misses separately from generation mistakes.
- **Target M4 performance:** warm targeted answers within 60 seconds, broad scans within five minutes and a 60-minute Summary within 15 minutes. Record cold and warm runs separately, plus peak memory and swap; the complete flow must avoid out-of-memory failures.
- **Verification:** typechecks, production builds, Vitest and Swift tests; actual Recording through Summary and chat; citations, rename, restart, export, regeneration and deletion; missing Ollama/model, timeout, cancellation, malformed output, engine exit and offline operation after preparation.

These are release gates, not verified claims. Fix and rerun failed gates and report unperformed device or human-review checks explicitly. Overlapping voices and transcription errors remain limitations.

## Test audio

Test audio comes mostly from recordings made with people who have agreed to be recorded. You'll need to correct reference transcripts by hand for any recording used to measure accuracy.

**Audio never goes into git.** The repository ignores common audio formats. Keep recordings outside the repo, and commit only a manifest that says what each recording is and how to get it. Do not commit recordings of anyone who has not agreed, and do not use real work meetings.
