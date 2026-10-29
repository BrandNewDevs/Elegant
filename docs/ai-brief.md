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
- Historical long-Meeting consolidation grouped immutable extracted claims rather than asking a reducer to rewrite them. Every candidate has a required integer group assignment under its original speaker; code retains the original extracted clauses and their evidence. The TL;DR uses complete, ranked original claim-and-source bundles independently of the full point list. Group assignments establish bookkeeping, not extraction accuracy or factual support: review final decisions and ownership against the Transcript.
- Start with 8,192 context tokens, at most 2,048 response tokens and a conservative 5,500 UTF-8 byte serialized-input budget. Count instructions, evidence, history and retry messages together; check the margin against actual prompt-token counts. Use temperature zero, disable thinking explicitly within the bounded response budget, and allow at most three total attempts for invalid output. Connection errors are actionable failures, not blind retries.
- Centralize model settings and readiness checks. Support system/user messages, JSON Schema, timeouts, cancellation and operational metadata without logging Transcript content or prompts by default. Serialize AI jobs, release idle speech models before Gemma and cancel work before closing storage.

## Shared infrastructure now implemented

`pipeline/evidence.ts` computes ordered Transcript revisions and resolves segment ordinals, rejecting stale references. `OllamaClient.complete` supports system/user messages, schema output, bounded requests, cancellation through body reading, timeouts and token/timing metadata. `generate` remains the compatibility adapter. The frozen evaluation baseline has its own original transport and validator.

`AppCore.jobs` serializes pipeline work; Settings model preparation shares that queue. Cancelling an active job keeps its resource slot occupied until the underlying work settles. Shutdown cancels jobs, stops the engine, waits for work to settle, then closes storage. Successful transcription waits for `models_released` before returning; preparation unloads models too. Mac memory measurements remain pending. The Meetings window now shows queued and running AI work. It allows cancellation of queued work and active Summary/chat jobs, while active transcription remains owned until it settles.

## Evidence-backed Summary implementation

The app and evaluation command use `createReadableSummariser` with prompt version `readable-summary-v1`. The earlier `createGroundedSummariser` remains for historical comparison and its structural regression tests.

Working passages combine consecutive same-speaker segments separated by at most two seconds. Sentence and word boundaries bound evidence size; original stored Transcript content, speaker labels and ordinal references remain unchanged. Model evidence contains only IDs, speakers and text.

Extraction writes concise supported claims, omitting filler and unintelligible fragments while preserving meaningful short negatives. Bounded consolidation receives original evidence and must cover every extracted claim under its original speaker, including explaining superseded positions. Coverage is bookkeeping, not proof of semantic fidelity. The model writes readable prose instead of concatenating original clauses.

A separate generation request writes a supported TL;DR of usually 40–70 words and at most 90 words. For long Meetings, bounded selection requests choose representative claims for the overview; the full per-Participant list remains intact. All requests include complete schema and retry overhead in the 5,500-byte bound. Invalid output receives at most three attempts; cancellation, timeout and transport failures propagate. Unfinishable evidence produces a clear failure and cannot replace the previous saved Summary.

The public Summary and evidence fields remain compatible, with atomic replacement and no migration. Generation metadata additionally records request stage, byte count, attempt and elapsed time, without prompts or speech. New generations use the same local Gemma default. Semantic accuracy and useful topic selection require source review.

Participant renames reject duplicate effective names, including the profile name. Existing display-name collisions include stable labels in UI and export; storage identities and evidence remain distinct.

## Meeting-specific evidence retrieval

`pipeline/passages.ts` derives passages targeting 1,500 characters from original Transcript fragments. Oversized segments split at word boundaries where possible, retaining Unicode, segment ordinals and fragment IDs. SQLite passage FTS5 is separate from Meeting-list search. Transcript replacement rebuilds passages and their index atomically; old Transcripts receive missing derived records on store open. Lookups require both Meeting ID and current revision.

`createMeetingEvidence` in `pipeline/meeting-evidence.ts` returns original fragments, their revision, selection mode, model-call count and completeness flags. It checks stored fragment IDs against the current Transcript and returns canonical source text rather than trusting index text as evidence. Missing or changed evidence produces an incomplete result, never a claim that a fact was absent.

Use the full Transcript when it fits the caller's complete answer-request budget. Otherwise, ranked FTS5 lookup adds neighboring passages, the final passage and a scoped correction-term lookup to help find changes that omit the original topic words. One bounded query rewrite is allowed for an empty lookup or a contextual follow-up, using at most four recent exchanges. History helps resolve the question; generated answers are not factual sources. Returned fragments are deduplicated and chronological.

Question searches remove generic question words and favor passages matching the most distinct content terms, using the existing Porter FTS index. The separate correction lookup retains its OR semantics so a later change is not hidden by another passage with several correction words. Selection asks for direct support for the requested fact, not merely related review requirements. Broad questions, explicit final/latest/eventual questions and insufficient targeted evidence still scan all passages in bounded batches. Selection and consolidation return source IDs from original fragments, never generated replacement prose or model sufficiency flags. A nonempty validated set is usable context, not proof of a complete answer. Every initial scan batch must finish with valid IDs before an exhaustive empty result; losing all selected evidence during consolidation remains incomplete. An exhaustive result requires visiting the entire current Transcript. Deadline, call-limit or budget failures return incomplete evidence; user cancellation remains a cancelled operation. Neither incomplete retrieval nor a cancelled scan establishes that the answer is absent. The `sufficient` flag describes usable selected context; the chat answer still needs its own factual and citation validation. No embeddings or vector database are used.

The current retrieval prompt version is `meeting-evidence-v8`. Reduction batches include up to the latest two selected **original fragments** as comparison context, deduplicated and chronological within the same request budget. If both cannot fit with one candidate, context shrinks to one or none; candidate text is never trimmed. Later context supersedes an earlier proposal only when it changes the same fact. A newer unrelated task must not erase another necessary fact, and a non-compact complete answer remains incomplete rather than dropping facts to fit. Explicit unassigned ownership, an undecided date or rejection is usable evidence for a negative answer; generic warnings not to guess are not such evidence.

Retrieval, answer generation and persisted history are available through production modules and evaluation tooling. Application operations, the React view and citation navigation are implemented. Automated retrieval and chat checks do not pass the real-Meeting, human-review or M4 release gates.

## Meeting chat implementation

`createMeetingChat` in `pipeline/meeting-chat.ts` answers questions about one selected Meeting. Its input is a canonical-label question, the latest completed exchanges and an expected Transcript revision. The answer prompt requests English and uses only original Transcript fragments; the Summary and previous answers are never independent factual sources. History resolves follow-ups only. Missing owners, dates and agreements must not be guessed.

Follow-ups receive at most one bounded standalone-question rewrite before retrieval. The latest four completed exchanges supply intent to the rewrite; earlier assistant details are not factual evidence. After resolution, source selection receives user questions only, keeping prior assistant wording from priming factual answers. If the model returns malformed or unresolved wording, code keeps the two original user questions together as explicit intent context rather than guessing a subject or retrying indefinitely. Oversized combined questions produce an incomplete-review response without truncation. An internal flag prevents another lexical rewrite in retrieval. Connection errors and cancellation still propagate. The parser recognizes possessive “its” as well as other referential pronouns.

The current chat prompt version is `meeting-chat-v14`. The generator uses `createMeetingEvidence`, with a budget predicate covering the complete selection request: instructions, dynamic schema, original and resolved questions, original evidence, history and retry feedback. At most four completed exchanges enter context, dropping whole oldest exchanges first. Unrelated prior questions are not retained outside that budget. The model selects source IDs from a request-specific enum; code derives segment ordinals. Answer-selection calls are capped at 512 output tokens.

Chat is extractive: the model selects original sentence IDs and a sufficiency flag, never answer prose. Application code copies the whole original fragments containing the selected sentences under their actual speaker labels and derives segment references. Adjacent commitments and qualifiers remain visible; repeated fragment selections are deduplicated and chronological. IDs are scoped to the supplied current Transcript fragments; unknown IDs, injected prose or relabeled speakers are rejected. Whole original sentences avoid copied-quotation errors and quotation truncation, but a qualifier may still depend on neighboring speech and semantic review.

Selection is validated for known sentence IDs, current revision, input/output budgets and bounded retries before publication. App-authored speaker labels and literal source text prevent the model from inventing an answer's wording or attribution. A real sentence can still be irrelevant, superseded or incomplete; source identity is not proof of a correct answer. A second model self-audit was removed after synthetic tests showed it rejected explicit negative evidence and accepted wrong passages. Evaluation against the original Transcript, rather than that audit, measures relevance and completeness.

Requests present original evidence before the active question. The complete 5,500-byte budget includes source sentences, schemas, question context and retry messages. At most 64 sentence IDs can be selected; their full original fragments are shown for context. No source or selected fragment is truncated to meet a budget.

Application checks also reject a substituted Participant in narrow person questions, a weekday offered as a calendar date, and an unrelated non-amount offered as an explicit budget value. Malformed output, unknown IDs and injected answer prose receive at most three attempts and remain failures when unrepaired. Three well-formed but unverifiable semantic answers instead produce a distinct verification abstention, without publishing the rejected text or claiming the fact is absent. If targeted context cannot answer, one forced complete scan is still allowed before that limitation. A completed review finding no support returns "Not established in the available Transcript." Empty evidence paired with a contradictory positive sufficiency flag remains an unverified review; it cannot establish absence. An incomplete review asks for a narrower question; neither incomplete retrieval nor verification abstention is proof of absence. An oversized request returns an incomplete-review limitation.

The total generation deadline is five minutes, including retrieval, with a 128-call cap. Cancellation, transport failures, invalid output and Transcript changes cannot publish a completed answer. Operational failures remain failed requests with an actionable retry path. Generation metadata counts all question-rewrite, retrieval, answer-selection calls, token counts when available, model, timing, selection mode and exhaustiveness. Every call and final result rechecks the expected revision.

`MeetingChatController` and `AppCore` own per-Meeting request lifetimes in the shared AI queue. Operations send questions, read history, cancel, clear and resolve references. A completed Transcript is usable when Summary generation failed. Core can authorize queueing chat while only Summary work is pending, after checking that no transcription work is queued or active. The internal `allowSummaryProcessing` flag is trusted main-process input and must never be controlled by renderer IPC.

SQLite preserves the full history, statuses, citations, revision and generation metadata. Questions are canonicalized to stable Participant labels before storage; display projection substitutes current names in questions and answers. Ambiguous display-name mentions are rejected. Duplicate request IDs cannot create duplicate messages. Failed, cancelled and interrupted requests remain distinct; restart marks unfinished work interrupted. Clear chat and Meeting deletion cancel related work before deleting records. Request-lifetime and revision checks stop late results from recreating cleared history. Transcript replacement clears chat and rebuilds derived evidence; renames and Summary regeneration preserve chat.

## React Meeting experience

The Meetings window has Summary, Transcript and Chat tabs. Chat displays restored per-Meeting history and queued, retrieving, generating, completed, failed, cancelled and interrupted states. Send, Cancel, Retry and Clear chat call the application operations through the typed `MeetingsApi` preload interface. The local AI queue displays work and cancellation controls. Completed answers appear after validation; there is no token streaming or partial-answer publication.

Timestamp buttons on TL;DR evidence, per-Participant points and chat answers request main-process reference validation, then open the Transcript, scroll to the segment and highlight it. Navigation uses segment ordinals and revision fingerprints, not retained audio. Names are projected from current Participant settings while source identity remains stable. Markdown exports include supporting timestamps and current names but preserve spoken Transcript words; chat export remains deferred.

The sandboxed bridge exposes only the declared operations. Main-process handlers require the current Meetings window as sender and validate Meeting IDs, request IDs, revisions, reference lists and payload fields. The trusted Summary-processing authorization is not part of the renderer interface. Questions are capped at 2,000 characters in the renderer and main process, with visible validation feedback. Generated content is rendered as escaped text without raw HTML.

The existing Settings dialog, onboarding and packaging workflow remain in place. Human-reviewed reserved examples, real Recordings, offline native-app checks and M4 performance measurements remain pending until performed. Renderer and IPC tests establish behavior at those interfaces, not native permissions, speaker accuracy or factual quality.

## Remaining limits

- Short-Meeting point generation and refinement still use model-authored text. Long extraction preserves original wording but can misclassify substantive material as procedural. TL;DR selection copies whole extracted claims, so extraction errors can still reach it. Immutable long-Meeting grouping prevents a reducer from inventing replacement clauses, but does not prove the extracted claims are correct or complete. Retaining original clauses can leave verbose, repeated or superseded statements visible rather than rewriting them away.
- Targeted retrieval can miss relevant passages; broad scans can need many sequential calls or exceed the evidence budget. Original-sentence checks and narrow value/person guards reduce known mistakes but do not prove that the selector chose the right evidence. Incomplete and unverified responses remain useful limits, not successful answers to answerable critical questions.
- Recognition errors, mislabeled speakers and overlapping voices affect every downstream result. A correct reference points to the stored Transcript, not proof that the audio was recognized correctly.
- Synthetic runs and automated tests do not clear reserved real-Meeting review, actual offline native-app behavior, M4 memory or latency gates. Latest CI, agent source review, human quality review and device measurements are separate evidence; consult the comparison report for versioned observations rather than treating an earlier run as proof for the latest prompt.

## Evaluation and acceptance

Preserve the current summariser as a frozen baseline through its public interface. Record model name, digest, quantization, Ollama version, context settings, prompt version, hardware, latency and model-call count for each run. Compare `gemma3:4b` against at most `gemma4:e2b`; retain the baseline unless the candidate passes the same gates and improves measured results.

Use eight committed synthetic fixtures: straightforward discussion, proposal versus decision, changed decision, ambiguous ownership, disagreement, repetition, spoken misleading instructions and a long discussion. Keep four self-recorded examples outside Git: approximately 5 and 20 minutes for tuning, 10 and 60 minutes reserved for final evaluation. Synthetic length is not a substitute for a real 60-minute check.

Each example needs non-empty expected important points and questions, critical final decisions, attribution and evidence, answerable and absent-answer questions, and follow-ups. The [private export workflow](./ai-testing.md) creates an unprepared draft that must be reviewed before evaluation. Empty expectation sets remain pending in reports; an empty checklist cannot produce a quality pass. Correct representative real Transcript excerpts for word error rate and speaker attribution, and review every passage supporting an expected critical decision.

- **Summary quality:** no invented labels or invalid references, no critical unsupported decisions or ownership, at least 90% expected important-point coverage and every expected critical final decision represented.
- **Chat quality:** no unsupported critical claims or cross-Meeting evidence; all predefined answerable critical questions answered correctly with support. Record retrieval misses separately from generation mistakes.
- **Target M4 performance:** warm targeted answers within 60 seconds, broad scans within five minutes and a 60-minute Summary within 15 minutes. Record cold and warm runs separately, plus peak memory and swap; the complete flow must avoid out-of-memory failures.
- **Verification:** typechecks, production builds, Vitest and Swift tests; actual Recording through Summary and chat; citations, rename, restart, export, regeneration and deletion; missing Ollama/model, timeout, cancellation, malformed output, engine exit and offline operation after preparation.

These are release gates, not verified claims. Fix and rerun failed gates and report unperformed device or human-review checks explicitly. Overlapping voices and transcription errors remain limitations.

## Test audio

Test audio comes mostly from recordings made with people who have agreed to be recorded. You'll need to correct reference transcripts by hand for any recording used to measure accuracy.

**Audio never goes into git.** The repository ignores common audio formats. Keep recordings outside the repo, and commit only a manifest that says what each recording is and how to get it. Do not commit recordings of anyone who has not agreed, and do not use real work meetings.
