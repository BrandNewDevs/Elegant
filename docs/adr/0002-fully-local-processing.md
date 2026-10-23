# Fully local processing

Recordings, transcription and summaries never leave the machine. Transcription uses an on-device Whisper model and summaries use open-weight models served by a local Ollama, because the app records other people and the owner does not want their audio or words sent to a third party.

## Consequences

Summary quality is capped by what a 4B-class model can do on a 16 GB machine, and long Meetings will need to be split into chunks. Switching to a cloud API would improve quality but breaks the privacy promise, so it should be a deliberate reversal of this ADR rather than a quiet change.
