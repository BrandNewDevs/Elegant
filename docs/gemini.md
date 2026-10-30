# Optional Gemini Summary and Meeting Chat

Ollama remains the default. Its transport, model settings, Summary prompts and extractive Chat implementation are unchanged. Gemini is an explicit opt-in under [ADR 0003](./adr/0003-optional-gemini-processing.md). Recording, WhisperKit transcription and SpeakerKit diarization stay local. Audio is never uploaded.

## Setup

In Settings → Providers, use the Gemini card to save your own Gemini API key, choose a Gemini text model and test the connection. The model list is loaded from Google (the models endpoint, `generateContent`-capable models that are not image, speech, live-audio or embedding variants) once a key is saved, and again with the refresh button; only the key is sent for it, never Meeting content, and it does not enable Gemini. Google lists every model, whether or not the key's plan can use it, so "Find usable models" sends each listed model one tiny synthetic request (never Meeting content), one at a time, and the picker then offers only the models that answered. A model Google refuses with a quota of zero, or that stays rate-limited after one retry, is left out; a stopped run keeps what it found, and a new or removed key forgets the results. Gemini's quotas are per model, so each try is independent and uses a little of that model's own allowance. The initial Gemini model is `gemini-3.8-flash`; it is a starting choice, not a measured quality winner. Model access depends on the Google project. Review [Google's API-key guidance](https://ai.google.dev/gemini-api/docs/api-key), [available models](https://ai.google.dev/gemini-api/docs/models) and applicable data-use and billing terms before enabling cloud processing.

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

The test uses the saved model; choosing one in the model picker saves it. The synthetic connection check has a 60-second deadline and 2,048-token response allowance. For exactly `gemini-3.8-flash`, it explicitly requests low thinking; other models retain their defaults to avoid unsupported options, so a model that thinks heavily by default can still exhaust the allowance and fail the check with a token-limit error. Success requires valid JSON with `ok: true`.

Cancel connection test is shown only while a check runs. It aborts that check, including one still waiting behind another settings change or for the keychain, without entering the serialized credential-mutation queue. It does not cancel Meeting processing. Token exhaustion is reported separately from blocked output. A setup timeout points to network/model checks rather than suggesting a narrower Meeting question. These changes do not establish the cause of a particular Mac network delay; verify with the signed Mac app and synthetic content before using real Meetings.

## Checked against Google's documentation (30 October 2026)

Read from ai.google.dev; nothing here was verified with a live key.

- **Endpoint and key.** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, with the key in the `x-goog-api-key` header, as this app sends it. Google's quickstart now uses the newer Interactions API (`/v1beta/interactions`, `response_format`) and calls it the recommended successor for new projects; it describes `generateContent` as legacy but "fully supported". This app stays on `generateContent`: a move would change the request and reply formats and is not needed to work. The generation-config field names the app sends (`responseMimeType`, `responseJsonSchema`) could not be confirmed from the reference text that could be read, so a successful **Test Gemini connection** with a model on the key's plan is the real check.
- **Models.** `gemini-3.8-flash` (the default here) and `gemini-4-argon` are both listed as stable, along with `gemini-3.6-flash`, `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite`. The 2.5 models are legacy, limited to accounts that already used them. `gemini-2.0-*` is shut down.
- **Free tier.** Per Google's pricing page the free tier covers `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` and the 2.5 flash and pro models, and **`gemini-4-argon` is paid only**: on a free key it fails with a 429 whose limit is zero. Limits apply per project and per model, not per key, and the models list does not say which models are free, which is why "Find usable models" tries them.
- **Free-tier data use.** The pricing page says content sent to free-tier models may be used to improve Google's products. Meeting Transcripts are personal, so use a paid-tier project (or Ollama) for real Meetings, and read Google's terms. The consent text in Settings says this.
- **Thinking.** The Gemini 3 and 4 models think by default (medium for `gemini-3.8-flash` and `gemini-4-argon`), and thinking tokens count against `maxOutputTokens`. A request with a small cap can end before any answer is written, so the connection test and the model probe allow 2,048 tokens.

