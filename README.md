# Elegant

A personal macOS menu-bar app that notices when you are in an online call, offers to record it, and produces a Transcript and Summary. Processing is local by default. Optional Gemini Summary and Chat processing sends Transcript evidence and questions to Google only after explicit selection in Settings; audio stays on the Mac ([ADR 0003](./docs/adr/0003-optional-gemini-processing.md)).

## What it does

- **Detects calls.** Any app that holds the microphone (Zoom, Teams, Slack, FaceTime, Meet in a browser, and so on) triggers a small prompt: **Record**, **Not now** or **Never for this app**. The prompt times out after about 20 seconds and defaults to not recording. The last few minutes of audio are held in memory from detection, so accepting late doesn't lose the start of the call; declining discards them.
- **Records two tracks.** Your microphone and the system audio (everyone else) are captured separately. The menu bar shows elapsed time. Stopping is always manual; you only get a reminder when the call app lets go of the microphone.
- **Transcribes locally.** After you stop, WhisperKit transcribes the whole recording (English only). Other voices are separated by speaker diarization and labelled "Speaker 1", "Speaker 2", and so on. You can rename any speaker per meeting.
- **Summarises locally.** A local model served by Ollama (default `gemma3:4b`) writes a TL;DR and what each participant said. Every point links to the transcript passage that supports it, and clicking a timestamp jumps to and highlights that passage. Long meetings are handled in bounded chunks.
- **Chat with a meeting.** Ask questions about one meeting in the Chat view. Answers cite transcript segments, history is saved per meeting, and you can cancel, retry or clear a chat.
- **Optional Gemini.** Choose Gemini in Settings, save your own API key and acknowledge cloud processing. Gemini writes evidence-backed Summaries and synthesised Chat answers without requiring Ollama. Local remains the default, with no automatic cloud fallback. See [Gemini setup and verification](./docs/gemini.md).
- **Meetings window.** Browse, full-text search, and open a meeting in its Summary, Transcript or Chat view. Regenerate a summary, export a meeting to Markdown (summary, transcript and supporting timestamps), or delete a meeting and all its data.
- **Your name.** Set it once in Settings → General and it replaces "You" in transcripts, summaries and exports.
- **Menu-bar controls.** Open the app, Settings (⌘,), keep audio after transcription (off by default; audio is otherwise deleted once transcription succeeds), show in Dock (on by default), ignored apps, and apps you chose "Never" for.
- **Launches at login** when installed as the packaged app.
- **AI work is queued.** Model preparation, transcription, summaries and chat run one at a time, shown as toasts. Detection and recording stay responsive.

**Out of scope:** live captions, calendar integration, in-person meetings, languages other than English, cloud audio processing, and cross-meeting chat. See [`docs/design.md`](./docs/design.md) for the full design.

## Requirements

- An Apple Silicon Mac running **macOS 14.2 or later** (system-audio capture needs it). The target machine is a 16 GB M4.
- For local Summary and Chat processing, [Ollama](https://ollama.com) installed and running, with the summary model pulled:

  ```sh
  ollama pull gemma3:4b
  ```

To build from source you also need:

- **Xcode** (not just the Command Line Tools; the Swift tests need it) with Swift 5.9 or later.
- **Node.js** 24 and **pnpm** 12 (the versions CI uses).

## Setup

### Install a release

1. Download the `.dmg` from the [releases page](https://github.com/BrandNewDevs/Elegant/releases), open it and drag Elegant to Applications.
2. Open Elegant from Applications. macOS blocks it, because the app is signed with a personal certificate rather than an Apple Developer ID (so it is not notarized). The dialog offers **Done** and **Move to Trash**; choose **Done**.
3. Allow it once. On **macOS 15 (Sequoia) and later**:
   1. Open **System Settings → Privacy & Security**.
   2. Scroll down to the **Security** section, which says Elegant was blocked to protect your Mac.
   3. Click **Open Anyway**. The button appears only after the first blocked launch, and only for about an hour afterwards. If it's missing, open Elegant again and come back.
   4. macOS may ask for your password or Touch ID. Confirm, then click **Open** in the last dialog.

   On macOS 14 (Sonoma) the same **Open Anyway** button should be in the same place, and Control-clicking Elegant and choosing **Open** should work too (macOS 15 removed that route). We haven't tested macOS 14.
4. Follow onboarding (see [First run](#first-run)).

If you get stuck, or would rather not click through the dialog, you can remove the quarantine flag macOS puts on downloaded files. This is optional; Gatekeeper then never prompts for this app:

```sh
xattr -dr com.apple.quarantine /Applications/Elegant.app
```

### Updates

From version 0.1.3 on, Elegant updates itself. At launch it asks GitHub whether a newer release is published, downloads it in the background and shows **Version X is ready. Restart to update**; **Restart** (in the sidebar, Settings → Updates and the menu bar) installs it and reopens the app. It never restarts by itself, and it refuses while a Recording is running or a Meeting is being processed. Updating sends nothing about you or your Meetings, and updates are accepted only if they are signed with the same certificate as the installed app. The **Check for updates** switch in Settings turns the check off. If an update fails, the toast links to the release page.

Earlier versions have no updater, so the first update (to 0.1.3 or later) is installed by hand: download the `.dmg` as above and replace the app in Applications.

### Run from source

```sh
cd app
pnpm install
pnpm start        # builds the renderer, the app and the Swift engine, then launches the menu-bar app
```

The first build downloads Swift package dependencies and can take a while. If you launch Electron by hand, run it with `env -u ELECTRON_RUN_AS_NODE`; with that variable set it exits silently.

### Build the app yourself

```sh
cd app
pnpm run package [identity]   # builds app/out/<name>.app
```

macOS ties the microphone and system-audio permissions to the signing identity, and an ad-hoc signature (the default) changes on every rebuild, so you'll be asked again each time. For a stable result, create a self-signed code-signing certificate in Keychain Access and pass its name as `identity`. No Apple Developer account is needed for your own Mac.

### First run

1. **Onboarding** asks for your name (optional) and walks through the two macOS permissions, one screen each: **Microphone** and **System audio capture**. Nothing is requested until you press its button.
2. **Settings** (⌘, or the Settings entry in the sidebar) is a page with sections: General (your name, **Show in Dock**, **Keep audio after transcription**), Permissions, Models (the speech and speaker model downloads and the Ollama check) and Updates. If Ollama isn't running or lacks the model, Settings tells you the command to run. Missing models also download on first use, so none of this blocks recording.

If you turn a permission off later, Settings reports where to turn it back on in System Settings, and **Check again** picks it up.

## Using it

1. Join a call. When the app sees the microphone in use, the prompt appears; press **Record**.
2. Press **Stop recording** from the menu bar when the call ends.
3. Open the app from the menu bar (**Open …**) and wait for the toasts to finish. The meeting then has a Summary, Transcript and Chat.

Apps that cause false prompts (dictation tools, voice search) can be listed in `ignored-apps.json`, opened from **Ignored apps…** in the menu bar. Changes apply immediately.

## Development

Run these from `app/`:

| Command | What it does |
| --- | --- |
| `pnpm install` | Install dependencies |
| `pnpm run typecheck` | Typecheck the main process and the renderer |
| `pnpm test` | Build the engine, run its Swift tests, then the Vitest suite |
| `pnpm start` | Build and run the menu-bar app |
| `pnpm run package [identity]` | Build the signed `app/out/<name>.app` |
| `pnpm run release <identity>` | Build the `.dmg`, a `.zip` of the app and `latest-mac.yml` (what the updater reads) and attach all three to a draft GitHub release for `package.json`'s version |
| `pnpm run eval:ai`, `eval:baseline`, `eval:retrieval` | AI evaluation harnesses (see [`evaluation`](./evaluation)) |

Releases normally come from CI: push a `v<version>` tag that matches `app/package.json` and the Release workflow builds the `.dmg`, the `.zip` and `latest-mac.yml` and attaches them to a draft release. Publish the draft once you've checked it: installed copies of 0.1.3 or later see only a published release, so publishing is what rolls the update out.

### Layout

- `app/`: the Electron app (TypeScript, ES modules). The main window, onboarding and the prompt are React + Tailwind + shadcn/ui pages in `app/src/renderer/`.
- `engine/`: the Swift engine (a SwiftPM package) for detection, two-track capture, WhisperKit and SpeakerKit. It talks to the app over JSON lines on stdio; the protocol lives in `app/src/engine/protocol.ts`.

### Docs

- [`docs/design.md`](./docs/design.md): what we are building and what is out of scope.
- [`GLOSSARY.md`](./GLOSSARY.md): the project's vocabulary.
- [`docs/adr/`](./docs/adr/): decisions that are hard to reverse.
- [`docs/ai-brief.md`](./docs/ai-brief.md): the AI pipeline and its input/output contract.
- [`AGENTS.md`](./AGENTS.md): rules for contributors and coding agents.
