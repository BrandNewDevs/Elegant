# Design

Working name: **Elegant** (display name only; the name will change). Domain vocabulary is in [`GLOSSARY.md`](../GLOSSARY.md). Decisions that are hard to reverse are in [`docs/adr/`](./adr/).

A personal macOS menu-bar app that notices when you are in an online call, offers to record it, and produces a transcript and summary entirely on your own machine. Single user. No calendar.

## Flow

1. **Detection.** The Swift engine sees a known call app holding the microphone. Known apps: Zoom, Microsoft Teams, Slack, FaceTime, and browsers (for Google Meet). The list is an editable settings file. Browsers will sometimes cause false prompts; the Prompt is cheap to dismiss, so that is accepted.
   The engine reports each process that uses the microphone, mapped to the outermost app in its executable path; the app folds helper processes into one app and applies a debounce (default 2 s, in `app/src/core/detection.ts`, to be tuned in the demo pass). Until the settings file exists the list is hard-coded in the same file. A declined Meeting is not asked about again until the app releases the microphone. Whether Safari and FaceTime, whose audio may run in system processes outside any `.app`, are reported at all is untested; see the open risks.
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

## Verified by the detection prototype

From the `prototype/detection` branch (see `prototypes/detection/FINDINGS.md` there), on macOS 27.0.1:

- Per-process microphone use can be read from CoreAudio process objects (PID, bundle id, input and output running). Reading them needs no permission. A test process produced exactly one start and one stop at a 100 ms poll, with no flapping.
- Browsers and Electron apps run audio in helper processes, so the PID is not the app's. Detection maps the PID to the outermost `.app` in its executable path. This is untested against a real browser call.
- Two-track Recording works: the microphone via AVAudioEngine, system audio via a Core Audio process tap.
- **The two tracks must be aligned on host time, not on the start of the file.** The system track starts about 197 ms before the mic track, repeatably. The engine records each track's first-sample host time and aligns on that before it writes the files: the later track gets leading silence, and both are cut to the same length. `tracks_ready` carries the two start times for reference.
- A Swift helper embeds and runs inside an Electron bundle with identifier `dev.bnd.meetingrecorder`.

## Open risks

- Detection maps a process to the `.app` in its executable path and drops processes with none. Safari (WebKit helper services) and FaceTime (system daemons) may fall in that gap. Untested against real calls; the prompt shows only Record and Not now until "Never for this app" is built.
- Which signal each call app produces (Zoom, Teams, a Slack huddle, FaceTime, Meet in a browser), how long the debounce should be, and which things cause false Detections (dictation, Siri, browser voice search). Needs real calls on the machine.
- Whether the embedded helper keeps its microphone and system-audio permissions across relaunch and rebuild. Not yet tested: the bundle's own permission was never exercised, because it could not be launched through LaunchServices and no signing identity exists on the machine. With ad-hoc signing every rebuild probably changes the code requirement and re-prompts, so a stable signing identity is a prerequisite for building the real app.
- Whether the mic and system tracks line up acoustically, not only by host time, and whether that holds on other devices such as Bluetooth headsets.
- Whether a 4B-class local model is good enough to attribute statements to the right Participant in long Meetings. This one is answered by the AI work in [`ai-brief.md`](./ai-brief.md).
