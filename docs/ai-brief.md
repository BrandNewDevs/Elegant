# AI pipeline brief

For whoever builds the AI side. Read [`design.md`](./design.md) and [`GLOSSARY.md`](../GLOSSARY.md) first, and the two ADRs in [`docs/adr/`](./adr/).

## What you own

1. **Summarisation, fully.** The prompts, how long Meetings are chunked, the "what each Participant said" output, and a way to judge quality.
2. **Meeting chat.** Answer questions about one selected Meeting, with supporting Transcript references and locally persisted history.
3. **Transcription and diarization model evaluation.** Measure recognition and attribution errors and recommend models with an Apple Silicon route.

Production AI logic lives in the Electron app's TypeScript pipeline. Swift owns transcription and diarization. Ollama serves Gemma. Python only collects evaluation results and calculates metrics; it is not a production runtime. Evaluation must invoke the same TypeScript modules as the app, not a separate Python implementation.

The delivery order is evidence-backed Summaries, then Meeting chat. English Meetings up to 60 minutes are the initial target. Evidence-backed Summary generation, shared request infrastructure, Meeting-specific original-evidence selection and persisted Meeting chat are implemented in the backend. The React chat view, user controls, citation navigation and Summary evidence timestamps in Markdown exports are implemented. Quality and target-device gates below remain unverified until their evaluations are completed.

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
- Short Transcripts use one bounded Summary request, with optional bounded refinement of repeated points against original evidence. Long Transcripts use extraction, then bounded consolidation with original source passages and references. Preserve proposals, commitments, disagreement, unresolved matters and later corrections. Never silently truncate or publish an incomplete result as complete.
- Long-Meeting consolidation accounts for every candidate through coverage IDs and keeps all retained per-Participant facts independently of the final TL;DR request size. Completed comparisons may leave distinct facts unchanged. The TL;DR uses ranked complete fact-and-original-source bundles that fit its budget; other facts remain in the points. Coverage IDs establish bookkeeping, not semantic preservation: review the actual final decisions and ownership against the source.
- Start with 8,192 context tokens, at most 2,048 response tokens and a conservative 5,500 UTF-8 byte serialized-input budget. Count instructions, evidence, history and retry messages together; check the margin against actual prompt-token counts. Use temperature zero and at most three total attempts for invalid output. Connection errors are actionable failures, not blind retries.
- Centralize model settings and readiness checks. Support system/user messages, JSON Schema, timeouts, cancellation and operational metadata without logging Transcript content or prompts by default. Serialize AI jobs, release idle speech models before Gemma and cancel work before closing storage.

## Shared infrastructure now implemented

`pipeline/evidence.ts` computes ordered Transcript revisions and resolves segment ordinals, rejecting stale references. `OllamaClient.complete` supports system/user messages, schema output, bounded requests, cancellation through body reading, timeouts and token/timing metadata. `generate` remains the compatibility adapter. The frozen evaluation baseline has its own original transport and validator.

`AppCore.jobs` serializes pipeline work; Settings model preparation shares that queue. Cancelling an active job keeps its resource slot occupied until the underlying work settles. Shutdown cancels jobs, stops the engine, waits for work to settle, then closes storage. Successful transcription waits for `models_released` before returning; preparation unloads models too. Mac memory measurements remain pending. The Meetings window now shows queued and running AI work. It allows cancellation of queued work and active Summary/chat jobs, while active transcription remains owned until it settles.

## Evidence-backed Summary implementation

The public `createGroundedSummariser` interface in `pipeline/grounded-summariser.ts` implements the Summary contract. The app and evaluation runner use it; the frozen original summariser remains available only for comparison. It returns the compatible Summary fields with optional `evidence` and `generation` sidecars.

`evidence` contains the Transcript `revision`, TL;DR segment ordinals in `tldr`, and per-Participant `said` reference lists aligned with the existing Summary points. `generation` records prompt version, model, elapsed time, request count and available token counts. Speaker labels remain stable internally; Participant renames affect presentation only.

Short inputs use one Summary request and optional bounded refinement. Refinement maps each merged point to indexed draft points; code unions their original references and preserves the TL;DR. Missing coverage is rejected, and invalid optional refinement retains the initial validated draft after bounded retries. Larger inputs use bounded extraction and consolidation while preserving original segment references and relevant source text. Structural validation rejects unknown labels and references, duplicate Participants and empty points; factual accuracy still requires review. Empty Transcripts complete without a Summary. Failed regeneration leaves the last successful Summary and sidecars intact.

The additive schema version 3 migration creates `summary_artifacts`, `chat_requests`, `passages` and `passage_index`. Summary artifacts are saved atomically with Summary text. Passage storage is now wired and existing Transcripts are backfilled when the store opens, without another migration. The chat table now stores per-Meeting requests, statuses, validated answers and generation metadata, using the same additive migration. Existing version 2 data and legacy Summaries without artifacts remain readable; regeneration adds evidence.

The React Summary and Chat views show timestamp references. Main-process validation resolves the current revision before the UI opens and highlights the Transcript passage. Markdown exports add supporting timestamps to the TL;DR and per-Participant points; evidence is checked against raw labels before display-name projection. Legacy Summaries export without invented references, and stale or invalid evidence produces no misleading timestamp. Neither UI navigation nor Markdown timestamps requires retained audio. Passing structural tests is not a claim that the human-reviewed Summary quality or M4 performance gates have passed.

## Meeting-specific evidence retrieval

`pipeline/passages.ts` derives passages targeting 1,500 characters from original Transcript fragments. Oversized segments split at word boundaries where possible, retaining Unicode, segment ordinals and fragment IDs. SQLite passage FTS5 is separate from Meeting-list search. Transcript replacement rebuilds passages and their index atomically; old Transcripts receive missing derived records on store open. Lookups require both Meeting ID and current revision.

`createMeetingEvidence` in `pipeline/meeting-evidence.ts` returns original fragments, their revision, selection mode, model-call count and completeness flags. It checks stored fragment IDs against the current Transcript and returns canonical source text rather than trusting index text as evidence. Missing or changed evidence produces an incomplete result, never a claim that a fact was absent.

Use the full Transcript when it fits the caller's complete answer-request budget. Otherwise, ranked FTS5 lookup adds neighboring passages, the final passage and a scoped correction-term lookup to help find changes that omit the original topic words. One bounded query rewrite is allowed for an empty lookup or a contextual follow-up, using at most four recent exchanges. History helps resolve the question; generated answers are not factual sources. Returned fragments are deduplicated and chronological.

Broad questions, explicit final/latest/eventual questions and insufficient targeted evidence scan all passages in bounded batches. Selection and consolidation return source IDs from original fragments, never generated replacement prose. An exhaustive result requires visiting the entire current Transcript. Deadline, call-limit or budget failures return incomplete evidence; user cancellation remains a cancelled operation. Neither incomplete retrieval nor a cancelled scan establishes that the answer is absent. The `sufficient` flag describes usable selected context; the chat answer still needs its own factual and citation validation. No embeddings or vector database are used.

Retrieval, answer generation and persisted history are available through production modules and evaluation tooling. Application operations, the React view and citation navigation are implemented. Automated retrieval and chat checks do not pass the real-Meeting, human-review or M4 release gates.

## Meeting chat implementation

`createMeetingChat` in `pipeline/meeting-chat.ts` answers questions about one selected Meeting. Its input is a canonical-label question, the latest completed exchanges and an expected Transcript revision. The answer prompt requests English and uses only original Transcript fragments; the Summary and previous answers are never independent factual sources. History resolves follow-ups only. Missing owners, dates and agreements must not be guessed.

Follow-ups receive one bounded standalone-question rewrite before retrieval, including when the full Transcript fits. The previous user question supplies the intended task or person; earlier assistant details are not factual evidence. The original question remains intent context. An internal flag skips a second lexical query rewrite after this resolution. Unresolved referential pronouns receive corrective feedback to name the task or person explicitly, with at most three rewrite attempts. The 2,000-character limit remains enforced by the parser: putting that large `maxLength` in the rewrite schema caused a confirmed local Ollama grammar error, so the schema omits it.

The generator uses `createMeetingEvidence`, with a budget predicate covering the complete answer request: instructions, dynamic schema, original and resolved questions, original evidence, history and retry feedback. At most four completed exchanges enter context, dropping whole oldest exchanges first. The model selects source IDs from a request-specific enum; code derives segment ordinals. Answers are capped at 512 output tokens. Malformed output or unknown IDs receives at most three attempts per answer stage. If a targeted context cannot answer, one forced complete scan and answer retry is allowed. A completed review without support returns "Not established in the available Transcript." An incomplete review instead asks for a narrower question; it cannot claim absence. Every positive answer also receives a focused evidence audit before publication: original and resolved questions, the previous user question as intent context, candidate text and only its cited original fragments. The audit receives no previous assistant answers or Summary. A failed support or relevance check triggers bounded regeneration; repeated failure remains failed. An oversized audit returns an incomplete review rather than publishing an unaudited answer. This same-model audit can share the generator's mistakes; it does not prove factual correctness or replace human evaluation.

The total generation deadline is five minutes, including retrieval, with a 128-call cap. Cancellation, transport failures, invalid output and Transcript changes cannot publish a completed answer. Operational failures remain failed requests with an actionable retry path. Generation metadata counts all question-rewrite, retrieval, answer and audit calls, token counts when available, model, timing, selection mode and exhaustiveness. Every call and final result rechecks the expected revision.

`MeetingChatController` and `AppCore` own per-Meeting request lifetimes in the shared AI queue. Operations send questions, read history, cancel, clear and resolve references. A completed Transcript is usable when Summary generation failed. Core can authorize queueing chat while only Summary work is pending, after checking that no transcription work is queued or active. The internal `allowSummaryProcessing` flag is trusted main-process input and must never be controlled by renderer IPC.

SQLite preserves the full history, statuses, citations, revision and generation metadata. Questions are canonicalized to stable Participant labels before storage; display projection substitutes current names in questions and answers. Ambiguous display-name mentions are rejected. Duplicate request IDs cannot create duplicate messages. Failed, cancelled and interrupted requests remain distinct; restart marks unfinished work interrupted. Clear chat and Meeting deletion cancel related work before deleting records. Request-lifetime and revision checks stop late results from recreating cleared history. Transcript replacement clears chat and rebuilds derived evidence; renames and Summary regeneration preserve chat.

## React Meeting experience

The Meetings window has Summary, Transcript and Chat tabs. Chat displays restored per-Meeting history and queued, retrieving, generating, completed, failed, cancelled and interrupted states. Send, Cancel, Retry and Clear chat call the application operations through the typed `MeetingsApi` preload interface. The local AI queue displays work and cancellation controls. Completed answers appear after validation; there is no token streaming or partial-answer publication.

Timestamp buttons on TL;DR evidence, per-Participant points and chat answers request main-process reference validation, then open the Transcript, scroll to the segment and highlight it. Navigation uses segment ordinals and revision fingerprints, not retained audio. Names are projected from current Participant settings while source identity remains stable. Markdown exports include supporting timestamps and current names but preserve spoken Transcript words; chat export remains deferred.

The sandboxed bridge exposes only the declared operations. Main-process handlers require the current Meetings window as sender and validate Meeting IDs, request IDs, revisions, reference lists and payload fields. The trusted Summary-processing authorization is not part of the renderer interface. Questions are capped at 2,000 characters in the renderer and main process, with visible validation feedback. Generated content is rendered as escaped text without raw HTML.

The existing Settings dialog, onboarding and packaging workflow remain in place. Human-reviewed reserved examples, real Recordings, offline native-app checks and M4 performance measurements remain pending until performed. Renderer and IPC tests establish behavior at those interfaces, not native permissions, speaker accuracy or factual quality.

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
