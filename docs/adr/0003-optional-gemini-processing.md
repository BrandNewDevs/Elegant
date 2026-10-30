# Optional Gemini processing for Summaries and Meeting Chat

Supersedes ADR 0002 only when the user explicitly selects Gemini in Settings.

Ollama remains the default. Its existing Summary and extractive Chat implementations,
model settings and prompts remain unchanged. Gemini is a separate, opt-in text AI
provider using the user's own API key. Recording, transcription and diarization
remain on the Mac; audio is never uploaded.

Selecting Gemini requires acknowledging that Transcript evidence and questions go
to Google and may incur charges. There is no automatic cloud fallback. One global
Settings choice controls new AI operations. Running operations retain their provider
and model; existing results and history are not rewritten when the choice changes.

The main process protects the API key using OS-backed encryption, never exposing
the saved key to renderers, exports or diagnostics. Gemini generates evidence-backed
Summaries and synthesised Chat answers through separate production paths. Source
identity checks are necessary but do not prove semantic correctness; shared synthetic
examples and source review must evaluate quality before making improvement claims.

## Consequences

The local-only promise applies to Ollama mode. Product copy must distinguish it
from optional Gemini processing. Gemini needs network access, an API key and quota;
failures remain actionable failures rather than silently changing providers. Native
audio and Mac credential behavior still need device verification.
