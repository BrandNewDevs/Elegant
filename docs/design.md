# Design

Working name: **Elegant** (display name only; the name will change). Domain vocabulary is in [`GLOSSARY.md`](../GLOSSARY.md). Decisions that are hard to reverse are in [`docs/adr/`](./adr/).

A personal macOS menu-bar app that notices when you are in an online call, offers to record it, and produces a transcript and summary entirely on your own machine. Single user. No calendar.

## Flow

1. **Detection.** The Swift engine sees an app holding the microphone. Any process mapped to a `.app` bundle counts (Zoom, Teams, Slack, FaceTime, Meet in any browser, and so on) except built-in ignores (Siri, dictation-style apps such as Wispr Flow, and others in `app/src/core/detection.ts`) and apps listed in `ignored-apps.json` (`{ "ignoredApps": [...] }`, opened from the menu bar's "Ignored apps…"). Browsers will sometimes cause false prompts; the Prompt is cheap to dismiss, so that is accepted.
   The engine reports each process that uses the microphone, mapped to the outermost app in its executable path; the app folds helper processes into one app and applies a debounce (default 2 s, in `app/src/core/detection.ts`, to be tuned in the demo pass). The ignore file is read again at each microphone event, so an edit applies at once; an unreadable file keeps the last good list. A declined Meeting is not asked about again until the app releases the microphone. Whether Safari and FaceTime, whose audio may run in system processes outside any `.app`, are reported at all is untested; see the open risks.
2. **Prompt.** An overlay offers **Record**, **Not now** and **Never for this app**. Never is stored in SQLite (`neverApps`) and that app is not detected or buffered again; the menu bar's "Never prompt for" submenu lists such apps and choosing one undoes it. The Prompt times out after about 20 seconds and defaults to **not recording**. From Detection onward the app holds the last few minutes of audio in memory; accepting keeps them, declining or ignoring discards them. Nothing is stored for a declined Meeting. At Detection the app sends `start_buffer`; the engine captures both tracks into memory only (the last 5 minutes, `preBufferSeconds` in `engine/Sources/engine/PCMBuffer.swift`). `start_recording` flushes that to the start of the Recording, and `discard_buffer` drops it. If the engine cannot buffer (for example microphone access is denied), `start_recording` starts from that moment instead and reports its own failure.
3. **Recording.** The microphone (you) and system audio (everyone else) are captured as two separate tracks. A menu-bar indicator shows elapsed time. **Stop is manual only.** When the call app releases the microphone the app shows a notification as a reminder (`AppCore.onStopNudge`), but never stops by itself.
4. **After Stop.** Transcription runs once over the full recording (not live), English only. Diarization labels the other voices "Speaker 1", "Speaker 2", and so on; the user can rename them. The engine diarizes the system track with SpeakerKit (Pyannote) after transcribing it: each segment goes to the voice that speaks longest within it, and voices are numbered by when they are first heard, so labels are stable within a Meeting (`engine/Sources/engine/SpeakerLabelling.swift`). Renames are per Meeting and stored on the Participant; the stored Transcript and Summary keep labels, and names are substituted at display (`app/src/core/participants.ts`). A local open-weight model via Ollama (default `gemma3:4b`) writes the Summary: a TL;DR plus what each Participant said. Summary generation now keeps supporting Transcript references and generation metadata alongside the existing TL;DR and per-Participant points. Long Meetings use bounded extraction and consolidation. Meeting chat and UI citation navigation remain upcoming work.
5. **Audio.** Deleted after a successful transcription. The "Keep audio after transcription" setting (menu bar, stored in SQLite, off by default) keeps it; deleting a Meeting removes kept audio too.

## App

- SQLite is the source of truth, with full-text search over Transcripts and Summaries.
- v1 features: Meeting list and detail view, Transcript with Participant labels, Summary, rename a Participant, delete a Meeting and all its data, regenerate a Summary, export a Meeting to Markdown, search.
- Launches at login. Models download on first run. First run also walks through the macOS permission prompts (microphone, system-audio capture) and checks that Ollama is running with a model pulled.
- Setup (`app/src/setup/setup.ts`) is shown in two places, both served by `app/src/main/setup-bridge.ts`. Onboarding (`onboarding-window.ts`) is its own small window that asks for the person's name (optional), then walks through the two macOS permissions, one screen each, and opens at launch only when a permission is missing. Settings is a dialog over the main window: "Settings…" in the menu bar (⌘,) or the Settings button in the sidebar opens it, and Esc or the close button dismisses it. It holds the person's name (stored as the `userName` setting and shown in place of "You" in every Meeting, the Summary and exports, unless that Meeting renamed You), shows each permission, and holds the speech and speaker model download and the Ollama check; neither of those blocks onboarding or recording, and a missing model downloads on first use. Each permission explains itself and is requested only when its button is pressed, so no macOS prompt appears unannounced.
- A granted permission is remembered in the store (`permission.microphone`, `permission.system_audio`) and checked again, without a prompt, when the engine reports `ready` and whenever the Settings dialog opens, so the person is asked once. The engine answers `check_permission` with `permission_result`; the microphone is read from its macOS status. System audio has no macOS call that reports its status, so the engine starts a tap briefly and counts a running tap as granted; that prompts if the person never answered, so the app sends it only for a permission it recorded as granted. A permission that was granted and is now off is reported as a problem with where to turn it back on. `request_permission` answers a permission that was already answered without a prompt, so "Check again" after fixing it in System Settings works. The models are remembered the same way (`modelsReady`).
- Bundle identifier: `dev.bnd.meetingrecorder`. It is permanent because macOS ties permissions and the login item to it; the display name lives in one config.

## Shape

A headless Swift engine (detection, two-track capture, WhisperKit, diarization) reports over stdio as JSON to an Electron/React app that owns the window, the Prompt overlay, SQLite and the Ollama call. One signed `.app`. See [ADR 0001](./adr/0001-swift-engine-electron-ui.md) and [ADR 0002](./adr/0002-fully-local-processing.md).

## AI delivery scope

The AI delivery targets English Meetings up to 60 minutes, in two milestones: evidence-backed Summaries first, then chat about the selected Meeting. Summary generation and its shared request infrastructure are implemented; Meeting chat, retrieval and UI citation navigation remain planned. The target duration and quality gates still require evaluation on reserved examples and the M4. TypeScript owns production AI logic, Swift owns transcription and diarization, Ollama serves Gemma locally, and Python is evaluation-only. Python is not shipped with the app.

- A Summary keeps its existing TL;DR and per-Participant points. Optional evidence and generation sidecars are stored atomically alongside it. Each factual point and the TL;DR link to supporting Transcript segments. Existing Summaries remain readable; regeneration adds evidence.
- References identify a segment by its ordinal within a fingerprinted Transcript revision. Renaming a Participant changes display names, never reference identity. The planned citation UI will open and highlight the Transcript at a timestamp; retained audio is unnecessary.
- Long Meetings use bounded extraction and consolidation, carrying original references and source passages through reductions. Suggestions, final decisions, disagreement and later corrections must stay distinct. Incomplete processing fails clearly, preserving any previous Summary.
- Planned chat answers questions about one selected Meeting using its original Transcript. Its history is saved locally per Meeting, with clear, cancel and retry controls. Unsupported answers say the available Transcript does not establish the answer. Summary text and earlier answers are not independent evidence.
- Planned passage-level FTS5 retrieval is scoped to the Meeting and current Transcript revision. Broad questions can scan all passages in bounded batches. No embeddings or vector database are required.
- The shared queue runs one AI job at a time for speech-model preparation, transcription and Summary generation; chat will use the same queue. Detection and Recording remain responsive. Idle speech models are released before Gemma generation; cancellation retains the occupied resource slot until work settles, and shutdown cancels work before closing storage.
- Transcript replacement invalidates its evidence and clears chat. Summary regeneration and Participant renaming preserve chat. Deleting a Meeting removes all related records and retained audio.

Schema version 3 adds Summary artifacts and reserves tables for chat requests, derived passages and passage FTS5. Existing Meetings and Summaries remain readable without regeneration. The later chat and retrieval deliveries wire those reserved tables.

The initial model is `gemma3:4b`; at most one alternative, `gemma4:e2b`, is compared on the same examples. Model selection follows measured quality, memory and latency on the target M4 rather than Linux timings. Automated structural validation does not establish factual accuracy; reserved examples need human review. See [the AI brief](./ai-brief.md) for contracts and evaluation gates.

## Out of v1

Live captions, calendar integration, in-person meetings, languages other than English, any cloud processing, cross-Meeting chat, fine-tuning and autonomous actions.

## Verified by the detection prototype

From the `prototype/detection` branch (see `prototypes/detection/FINDINGS.md` there), on macOS 27.0.1:

- Per-process microphone use can be read from CoreAudio process objects (PID, bundle id, input and output running). Reading them needs no permission. A test process produced exactly one start and one stop at a 100 ms poll, with no flapping.
- Browsers and Electron apps run audio in helper processes, so the PID is not the app's. Detection maps the PID to the outermost `.app` in its executable path. This is untested against a real browser call.
- Two-track Recording works: the microphone via AVAudioEngine, system audio via a Core Audio process tap.
- **The two tracks must be aligned on host time, not on the start of the file.** The system track starts about 197 ms before the mic track, repeatably. The engine records each track's first-sample host time and aligns on that before it writes the files: the later track gets leading silence, and both are cut to the same length. `tracks_ready` carries the two start times for reference.
- A Swift helper embeds and runs inside an Electron bundle with identifier `dev.bnd.meetingrecorder`.

## Open risks

- Detection maps a process to the `.app` in its executable path and drops processes with none. Safari (WebKit helper services) and FaceTime (system daemons) may fall in that gap. Untested against real calls.
- Which signal each call app produces (Zoom, Teams, a Slack huddle, FaceTime, Meet in a browser), how long the debounce should be, and which things cause false Detections (dictation, Siri, browser voice search). Needs real calls on the machine.
- Whether the embedded helper keeps its microphone and system-audio permissions across relaunch and rebuild. Not yet tested: the bundle's own permission was never exercised, because it could not be launched through LaunchServices and no signing identity exists on the machine. With ad-hoc signing every rebuild probably changes the code requirement and re-prompts, so a stable signing identity is a prerequisite for building the real app.
- Whether the mic and system tracks line up acoustically, not only by host time, and whether that holds on other devices such as Bluetooth headsets.
- Diarization runs on the whole system track as one blend, so two people talking over each other get one label, and a segment that spans a change of speaker is given to one of them. Not yet measured on real Recordings; both models are prepared during setup, with first-use download as a fallback.
- Whether a 4B-class local model is good enough to attribute statements to the right Participant in long Meetings. This one is answered by the AI work in [`ai-brief.md`](./ai-brief.md).
