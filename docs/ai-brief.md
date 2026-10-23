# AI pipeline brief

For whoever builds the AI side. Read [`design.md`](./design.md) and [`GLOSSARY.md`](../GLOSSARY.md) first, and the two ADRs in [`docs/adr/`](./adr/).

## What you own

1. **Summarisation, fully.** The prompts, how long Meetings are chunked, the "what each Participant said" output, and a way to judge quality.
2. **Transcription and diarization model evaluation.** Compare candidate models on accuracy and recommend which to use.

You do not need a Mac. The Swift engine will run the chosen models on Apple Silicon and the app work is handled elsewhere. Work in Python, and organise the code however suits you.

## What you can and can't conclude from Linux

Accuracy results carry over, because Whisper weights behave about the same on either platform. Speed and memory numbers do not, because the target machine is a 16 GB Apple M4. So:

- Report accuracy, and report model size and memory use too. Don't treat Linux timings as meaningful.
- Recommend only models that fit the M4: transcription and summarisation run one after the other, and each should stay under roughly 8 GB so there is room for the OS and the app.
- Whatever you recommend must have an Apple Silicon route (for example WhisperKit, whisper.cpp, MLX, or Core ML), or be clearly marked as not portable.

## Constraints

- **Fully local, open-weight only.** Nothing may call a cloud API ([ADR 0002](./adr/0002-fully-local-processing.md)). Summaries use models served by Ollama; the default is `gemma3:4b`.
- **English only.**
- **Transcription runs after the Meeting, in one batch.** Live or streaming transcription is out of scope.

## The two stages

They are separate so Summarisation can be developed without any audio. The contract below is a proposal. Change it if it is wrong, but record the change here.

### Stage 1: audio to Transcript

Input: two WAV files, 16 kHz mono, starting at the same instant and the same length.
- `mic.wav`: you.
- `system.wav`: everyone else, as one blended track.

Output: a Transcript as JSON.

```json
{
  "segments": [
    { "start": 12.3, "end": 15.8, "speaker": "You", "text": "..." },
    { "start": 16.1, "end": 20.4, "speaker": "Speaker 1", "text": "..." }
  ]
}
```

- Everything on `mic.wav` is labelled `You`.
- `system.wav` needs diarization. Its voices are labelled `Speaker 1`, `Speaker 2`, and so on. Labels are stable within one Meeting.
- Segments are ordered by `start`. Overlapping speech is allowed.

### Stage 2: Transcript to Summary

Input: the Transcript JSON above, with nothing else. Any Transcript will do, including ones from public sources.

Output: a Summary as JSON.

```json
{
  "tldr": "...",
  "participants": [
    { "speaker": "Speaker 1", "said": ["...", "..."] }
  ]
}
```

- `speaker` must be exactly a label from the Transcript. The app swaps in real names after the user renames a Participant, so the Summary must never invent or guess names.
- `said` holds the points that Participant made, not a quote of everything.
- Nothing may appear in the Summary that is not in the Transcript.

## What "good" looks like

These are defaults. Propose better ones if you have them.

- **Transcript:** word error rate against a corrected reference transcript.
- **Diarization:** how often a voice is given the right label.
- **Summary:** a short checklist per Meeting. Are the key points present, is each statement attributed to the right Participant, is anything invented, and does the TL;DR match what actually happened? No automated score at first.

## Open questions for you

- Which Whisper size and variant is the best accuracy/size trade-off?
- Which diarization approach works best on a single blended track with an unknown number of voices, and does it have an Apple Silicon route?
- How should a long Meeting be chunked so a 4B-class model keeps statements attributed correctly?
- Is `gemma3:4b` good enough, or does a different open-weight model do clearly better within the memory budget?

## Test audio

Test audio comes mostly from recordings made with people who have agreed to be recorded. You'll need to correct reference transcripts by hand for any recording used to measure accuracy.

**Audio never goes into git.** The repository ignores common audio formats. Keep recordings outside the repo, and commit only a manifest that says what each recording is and how to get it. Do not commit recordings of anyone who has not agreed, and do not use real work meetings.
