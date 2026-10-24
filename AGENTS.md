# AGENTS.md

A personal macOS app that detects online calls and records, transcribes and summarises them locally. Working name Elegant; the name will change, so don't hard-code it.

Read before changing anything:

- [`GLOSSARY.md`](./GLOSSARY.md): the project's vocabulary. Use these terms in code, docs and commits.
- [`docs/design.md`](./docs/design.md): what we are building and what is out of scope.
- [`docs/adr/`](./docs/adr/): decisions that are hard to reverse. Don't contradict them without writing a new ADR.
- [`docs/ai-brief.md`](./docs/ai-brief.md): the AI pipeline and its input/output contract.

Layout and commands:

- `app/` is the Electron app (TypeScript, ES modules). `engine/` is the Swift engine (a SwiftPM package). They talk over JSON lines on stdio; the protocol lives in `app/src/engine/protocol.ts`.
- Run these from `app/`: `pnpm install`, `pnpm run typecheck`, `pnpm test` (builds the engine and runs its Swift tests first), `pnpm start` (builds and runs the menu-bar app).
- Test at the seams in the spec (issue #2): drive `AppCore` with `FakeEngine` and `fakePipeline` from `src/testing/`, and test `ProcessEngine` against a stub or the built engine. Don't test internals.
- If you launch Electron by hand, run it with `env -u ELECTRON_RUN_AS_NODE`; with that variable set it exits silently.

Rules:

- Everything runs locally. No cloud APIs for audio, transcription or summaries.
- Never commit audio recordings, real Transcripts of real people, or `.env` files.
- The bundle identifier is `dev.bnd.meetingrecorder` and is permanent.
