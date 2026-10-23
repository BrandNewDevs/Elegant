# Design

Working name: **Elegant** (display name only; the name will change). Domain vocabulary is in [`GLOSSARY.md`](../GLOSSARY.md). Decisions that are hard to reverse are in [`docs/adr/`](./adr/).

A personal macOS menu-bar app that notices when you are in an online call, offers to record it, and produces a transcript and summary entirely on your own machine. Single user. No calendar.

## Flow

1. **Detection.** The Swift engine sees a known call app holding the microphone. Known apps: Zoom, Microsoft Teams, Slack, FaceTime, and browsers (for Google Meet). The list is an editable settings file. Browsers will sometimes cause false prompts; the Prompt is cheap to dismiss, so that is accepted.
2. **Prompt.** An overlay offers **Record**, **Not now** and **Never for this app**. It times out after about 20 seconds and defaults to **not recording**. From Detection onward the app holds the last few minutes of audio in memory; accepting keeps them, declining or ignoring discards them. Nothing is stored for a declined Meeting.
3. **Recording.** The microphone (you) and system audio (everyone else) are captured as two separate tracks. A menu-bar indicator shows elapsed time. **Stop is manual only.** When the call app releases the microphone the app nudges you to stop, but never stops by itself.
4. **After Stop.** Transcription runs once over the full recording (not live), English only. Diarization labels the other voices "Speaker 1", "Speaker 2", and so on; the user can rename them. A local open-weight model via Ollama (default `gemma3:4b`) writes the Summary: a TL;DR plus what each Participant said. Long Meetings are chunked.
5. **Audio.** Deleted after a successful transcription. A setting keeps it.

## App

- SQLite is the source of truth, with full-text search over Transcripts and Summaries.
- v1 features: Meeting list and detail view, Transcript with Participant labels, Summary, rename a Participant, delete a Meeting and all its data, regenerate a Summary, export a Meeting to Markdown, search.
- Launches at login. Models download on first run. First run also walks through the macOS permission prompts (microphone, system-audio capture) and checks that Ollama is running with a model pulled.
- Bundle identifier: `dev.bnd.meetingrecorder`. It is permanent because macOS ties permissions and the login item to it; the display name lives in one config.

## Shape

A headless Swift engine (detection, two-track capture, WhisperKit, diarization) reports over stdio as JSON to an Electron/React app that owns the window, the Prompt overlay, SQLite and the Ollama call. One signed `.app`. See [ADR 0001](./adr/0001-swift-engine-electron-ui.md) and [ADR 0002](./adr/0002-fully-local-processing.md).

## Out of v1

Live captions, calendar integration, in-person meetings, languages other than English, any cloud processing.

## Open risks

- Does per-process microphone detection work reliably for each call app on the target macOS version?
- Does a Swift helper embedded in the Electron bundle keep its microphone and system-audio permissions?
- Is a 4B-class local model good enough to attribute statements to the right Participant in long Meetings?

The first two are answered by a detection prototype; the third by the AI work described in [`ai-brief.md`](./ai-brief.md).
