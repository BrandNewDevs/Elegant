# AGENTS.md

A personal macOS app that detects online calls and records, transcribes and summarises them locally. Working name Elegant; the name will change, so don't hard-code it.

Read before changing anything:

- [`GLOSSARY.md`](./GLOSSARY.md): the project's vocabulary. Use these terms in code, docs and commits.
- [`docs/design.md`](./docs/design.md): what we are building and what is out of scope.
- [`docs/adr/`](./docs/adr/): decisions that are hard to reverse. Don't contradict them without writing a new ADR.
- [`docs/ai-brief.md`](./docs/ai-brief.md): the AI pipeline and its input/output contract.

Rules:

- Everything runs locally. No cloud APIs for audio, transcription or summaries.
- Never commit audio recordings, real Transcripts of real people, or `.env` files.
- The bundle identifier is `dev.bnd.meetingrecorder` and is permanent.
