# Optional Gemini Summary and Meeting Chat

Ollama remains the default. Its transport, model settings, Summary prompts and extractive Chat implementation are unchanged. Gemini is an explicit opt-in under [ADR 0003](./adr/0003-optional-gemini-processing.md). Recording, WhisperKit transcription and SpeakerKit diarization stay local. Audio is never uploaded.

## Setup

In Settings → Models, use the AI provider section to save your own Gemini API key, select an available Gemini text model and test the connection. The initial Gemini model is `gemini-3.8-flash`; it is a starting choice, not a measured quality winner. Model access depends on the Google project. Review [Google's API-key guidance](https://ai.google.dev/gemini-api/docs/api-key), [available models](https://ai.google.dev/gemini-api/docs/models) and applicable data-use and billing terms before enabling cloud processing.

Saving a key or testing it does not enable Gemini. The connection test sends a synthetic instruction, never Meeting content, and can consume a small amount of account quota. To enable Gemini, acknowledge that Transcript evidence and questions go to Google, then choose Use Gemini. This one global choice covers new Summary and Chat operations; there are no per-Meeting overrides or automatic provider fallbacks. Ollama is not required in Gemini mode. Removing a key leaves Gemini selected but unavailable until another key is saved or the user explicitly selects Ollama.

The main process uses Electron's asynchronous OS-backed safeStorage encryption (Keychain-backed on macOS) before saving ciphertext in local settings. No plaintext key is stored in SQLite or returned to the renderer. Local-only launches do not call the credential-encryption APIs. An unavailable/locked keychain fails closed, with instructions to unlock or replace the key. Keychain behavior, signing identity and app relaunch still need actual Mac verification.

## Behavior and contracts

Each generation captures the selected provider, model and credentials once, when the queued operation begins executing. A Settings change affects subsequent generations, never the model calls within an active generation. Existing Summaries and Chat history are preserved. New results record provider, returned model version, prompt version, calls, timing and token counts; Gemini results display their provider/model. Legacy metadata remains readable with no migration.

Gemini receives original Transcript fragments with stable IDs and speakers. Summary extraction accounts for each supplied fragment, omitting only non-substantive material. Consolidation must cover every extracted point under its original speaker and receives the original supporting evidence. The TL;DR has at most three sentences and 90 words. Citations derive from validated source identities, not model-added prose markers. Oversized consolidation fails rather than dropping source claims or publishing a partial Summary.

Chat uses the full original Transcript when it fits. Larger inputs scan every bounded batch and select original evidence before synthesis. Previous user questions resolve follow-up intent; previous generated answers and the Summary are not factual sources. Every published claim needs known original references. Explicit uncertainty is a supported answer; unverified output and incomplete evidence have distinct limitations. Transcript revisions are checked before publication. These checks validate structure and identity, not semantic truth; wrong or irrelevant real citations remain possible and require source review.

The Gemini-only serialized request bound is 192,000 UTF-8 bytes including schema/instructions. Responses are capped at 512 KiB, with up to 16,384 output tokens. Each request has a maximum 120-second deadline. Summary operations have a 15-minute deadline, Chat five minutes, and each operation at most 32 calls. Invalid output receives at most three attempts; transport, credential, quota and rate-limit errors do not trigger blind retries. Google error bodies are never forwarded because they can contain sensitive content. Requests use a fixed HTTPS Google endpoint, header credentials and disabled redirects. No audio, file-upload API, remote conversation state or tools are used. The API reference is [generateContent](https://ai.google.dev/api/generate-content); schema behavior follows [structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output).

## Evaluation

Build the app, then use the same synthetic fixtures and production Gemini modules as the app. Supply `GEMINI_API_KEY` through a secure process environment; do not create or commit a key file. From the repository root:

```sh
pnpm --dir app run build
AI_PROVIDER=gemini AI_MODEL=gemini-3.8-flash node app/dist/evaluation/cli.js current evaluation/fixtures /tmp/gemini-current.json
python3 evaluation/report.py /tmp/gemini-current.json --fixtures evaluation/fixtures --reviews /tmp/gemini-reviews.json --json /tmp/gemini-report.json
```

Use `summary` or `chat` to isolate a stage. Compare against the same fixtures using the unchanged Ollama commands in [the evaluation guide](../evaluation/README.md). The frozen baseline remains Ollama-only. Reports contain the requested model and each generation's returned model version, request/token counts, elapsed time and outputs. Google does not expose a local-model digest, quantization or inference RSS; remote latency and client RSS must not be represented as local inference measurements. Source-review judgments remain required.

Private cloud evaluation is refused before reading a manifest unless `AI_ALLOW_CLOUD_PRIVATE=1` is explicitly set. Only enable it with permission to send that material to Google. Keep private inputs and results outside Git. Private tracing remains forbidden. Without a real key, live Gemini quality, latency and usage comparisons are pending; fake-model tests do not establish an improvement over Ollama.

## Device acceptance

- Verify protected key save, replacement, removal and restoration after app relaunch on the signed Mac app. Check locked/unavailable keychain errors without losing existing settings or Meetings.
- Confirm fresh/default Ollama behavior, select Gemini with consent, test Summary/Chat, then switch back. Ollama prompts and model settings must remain identical. Changing settings during generation must not change that active operation.
- Test invalid/restricted keys, unavailable models, quota/rate limits, no network, cancellation and quit. Existing Summaries must survive failures and partial results must never publish.
- Review the same synthetic and permissioned real Transcripts for coverage, every critical final decision, attribution, citation support, readability, follow-ups and absent-answer questions. Record failures and costs/usage instead of claiming success from valid JSON.
- Verify citation navigation, rename, export, restart, regeneration and deletion with mixed legacy/local/Gemini results. Audio must never leave the Mac, and private/cloud processing must never activate silently.

## Connection-check recovery

Save model edits before testing; the test button uses the saved model and is disabled while edits are unsaved. The synthetic connection check has a 60-second deadline and 2,048-token response allowance. For exactly `gemini-3.8-flash`, it explicitly requests low thinking; other models retain their defaults to avoid unsupported options. Success requires valid JSON with `ok: true`.

Cancel connection test aborts the active check without entering the serialized credential-mutation queue. It does not cancel Meeting processing. Token exhaustion is reported separately from blocked output. A setup timeout points to network/model checks rather than suggesting a narrower Meeting question. These changes do not establish the cause of a particular Mac network delay; verify with the signed Mac app and synthetic content before using real Meetings.
