# Swift engine with an Electron UI

Detecting which app is using the microphone, capturing system audio and the microphone as separate tracks, and running WhisperKit and diarization on Apple Silicon all need native macOS APIs, so that work lives in a headless Swift engine that reports to the UI as JSON over stdio. The window, the Prompt overlay, SQLite and the summary call to Ollama live in an Electron app written in React. Both ship as one signed `.app`.

## Considered Options

- **All Swift (SwiftUI).** One language and one permission identity, but the owner knows React rather than SwiftUI, and a SwiftUI window is much harder for an agent to verify than a web UI.
- **All Electron.** Still needs a native Swift helper for detection and audio capture, so it only hides the split.
- **Tauri.** Adds Rust as a third language for little gain over Electron here.

## Consequences

macOS ties microphone and system-audio permissions to the app's bundle identifier and responsible process. A helper embedded in the Electron bundle must be confirmed to inherit them; this is the first thing the detection prototype has to prove.
