# Local AI setup, acceptance and recovery

The app runs on macOS; Linux can exercise the TypeScript pipeline and evaluation tooling. Automated tests and synthetic model runs do not establish real Meeting accuracy, native permissions, offline readiness or M4 performance. Those checks remain pending until performed on the target Mac.

## Prepare the Mac

1. Install the project's Node/pnpm toolchain, Xcode command-line tools and local Ollama. From `app/`, run `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run build` and `pnpm test`. The last command builds the Swift engine and runs its tests before app tests.
2. Start Ollama and prepare the configured model with `ollama pull gemma3:4b`. The production default is centralized in `app/src/pipeline/model-request.ts`. `AI_MODEL` selects a model for evaluation commands; it does not change the app's model. Changing a tag can change its weights, so compare the recorded digest and quantization, not just a similar name.
3. Run `pnpm start`. Onboarding requests microphone and system-audio permissions when their buttons are pressed. Open Settings, prepare the speech/speaker models and check Ollama. Give yourself a display name if desired.
4. Make a short actual Meeting Recording while online, with speech on both tracks. Confirm transcription and diarization complete. This exercises tokenizer/model assets that a download-only check might miss. Settings model readiness alone does not prove the complete offline workflow.
5. Keep private audio, original Transcripts, corrected references and evaluation fixture JSON outside the repository. Prepare the four pending examples in `evaluation/private-manifest.example.json`: 5 and 20 minutes for tuning, 10 and 60 minutes reserved for final review. Use only people who agree to be recorded.

## Export an actual Transcript for evaluation

The database path is `join(app.getPath("userData"), "meetings.db")` in `app/src/main/main.ts`. Use the **running build's actual userData directory**; the display name could differ between builds, so do not hard-code it into a path. On macOS the default location is under `~/Library/Application Support/`, but the directory name depends on the build. Read `app.getPath("userData")` locally in the Electron main-process debugger if needed. Do not choose an unrelated copy of the database.

Wait for Recording and transcription to finish. A Meeting marked failed can still be exported when it has a completed Transcript, such as after Summary failure. The exporter rejects Recording/processing states and empty Transcripts. Quit the app after completion for the simplest snapshot; the tool also uses a consistent SQLite read transaction if the app is open.

From the repository root, inspect only IDs and state, without printing any spoken words:

```sh
AI_DATABASE="/absolute/path/to/the/running-build-userData/meetings.db"
python3 - "$AI_DATABASE" <<'PYIDS'
from pathlib import Path
import sqlite3, sys
connection = sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + "?mode=ro", uri=True)
for meeting in connection.execute("SELECT id, state FROM meetings ORDER BY id DESC"):
    print(*meeting)
connection.close()
PYIDS
```

Choose the corresponding Meeting ID and an existing private directory **outside the repository**, then export a new draft:

```sh
python3 evaluation/export_private.py \
  --database "$AI_DATABASE" --meeting 7 --split tuning \
  --output /absolute/private/evaluation/5m.json
```

Replace ID 7 and the output path with the intended example. Use `reserved` for the 10- and 60-minute examples. The source database must also be outside the repository. The tool checks lexical and resolved paths, including symlinks and dangling output links. It opens the database read-only, creates a new file with owner-only permissions (`0600`), refuses overwrite and never prints Transcript content. Choose another output name if a file already exists.

The draft preserves the original segment order, timestamps and stable labels such as `You` and `Speaker 1`; it deliberately does not substitute Participant display names. Its `points` and `questions` lists start empty and `expectationsPrepared` is false. Review the Transcript privately, add expected important points, final decisions, source ordinals and questions using the schema in [the evaluation guide](../evaluation/README.md), then set `expectationsPrepared` to true. Until that review is done the evaluation runner refuses the draft. References are zero-based positions in the exported segment array, not SQLite row IDs.

Keep the original export unchanged as a private reference copy before preparing expectations. Store manually corrected speech excerpts separately for recognition/attribution scoring; do not silently replace the model Transcript when evaluating its Summary. Put the prepared fixture path into a filled private manifest outside Git. The example manifest's pending paths do not represent completed Recordings or evaluations.

## Measure performance and memory

`evaluation/measure.py` is a Python standard-library wrapper for an existing local command. It discards the command's stdout and stderr rather than saving Meeting content. Let the command write its own evaluation results to a private path. The measurement report contains resource observations, not questions, answers, command arguments or private file paths.

For a synthetic evaluation, run from `app/`:

```sh
AI_MODEL=gemma3:4b python3 ../evaluation/measure.py \
  --output /tmp/meeting-ai-resources.json --label warm --include-ollama \
  -- pnpm run eval:ai summary ../evaluation/fixtures /tmp/meeting-ai-summary.json
```

Use `current` instead of `summary` to include chat, or `chat` to measure chat alone. The elapsed time of a command processing several fixtures is its total duration, not one answer's latency. Use individual question timings in the evaluation result for the targeted/broad answer gates. For a private run, use the corresponding `private-summary`, `private-chat` or `private-current` mode and a filled manifest outside the repository; keep generated results there too.

- `--label cold` or `--label warm` records the operator's explicit label. Without it the report says `unspecified`. The wrapper does not establish model loading state. For a cold model run, unload the selected model with `ollama stop <model>` and verify `ollama ps` before launching. For a warm run, confirm the same model is resident and repeat promptly with identical settings. OS file caching is separate from model residency; record whether a full restart was used.
- `--include-ollama` separately samples processes named Ollama and their descendants, including an already-running server. These can overlap the launched command tree. Do not add their peaks together as a total memory figure.
- `--nvidia` adds optional NVIDIA device-memory observations on the Linux laptop. It is unnecessary on the M4. Missing tools produce missing values and warnings, never a false zero-memory result.
- `--interval 0.5` is the default requested sampling interval. Short-lived peaks can be missed. RSS sums include shared mappings and are not unique physical memory, total device memory, VRAM, or an Apple memory-pressure measurement. System swap and GPU usage include other applications.
- Linux samples `/proc` swap counters. macOS samples `sysctl vm.swapusage` and `vm_stat`; their values and page sizes are retained in the report. Observe Activity Monitor's memory pressure as well, and record other running apps. Report initial, peak and final swap, rather than calling existing swap a leak.
- `--timeout <seconds>` bounds the command if desired. SIGINT, SIGTERM and timeout stop the wrapper's own process group, including descendants that remain in that group. A command that deliberately detaches into another session escapes that cleanup; use a foreground evaluation command. Existing Ollama services outside that group remain running. A normal exit also cleans up children left by the launched command. Do not use the wrapper to launch a service you intend to leave running.
- A failed command still produces a resource report and preserves its exit code. Wrapper interruption exits 130, timeout 124 and launch failure 127. Forced SIGKILL, power loss or an unwritable output path cannot guarantee a saved report. Check both the resource report status and the evaluation result; elapsed time alone never means success.

Compare the same fixtures, model digest, quantization, prompt version, context settings and output limits on the M4 and laptop. Compare only Gemma 3 4B and the agreed `gemma4:e2b` candidate. Retain the baseline unless the candidate passes the same quality gates and improves measured results on the M4. Linux speed does not establish Swift or M4 performance.

## Review the current AI behavior

Long-Meeting extraction requires a classification for every original sentence; the model returns one ordered numeric kind code per sentence, and application code supplies its unchanged words, actual speaker and references. Grouping preserves immutable clauses rather than asking a reducer to write replacement claims. Check that substantive speech was not misclassified as procedure, that every distinct commitment, case-sensitive identifier and final decision survived, and read any retained earlier proposal in its chronology. Grouping may remain verbose. The TL;DR copies one to three selected whole extracted claims with speaker labels and derived references. Verify their original extraction against the cited passages; selection prevents a new compression error but does not prove the selected claims are faithful.

Chat selects IDs for complete original Transcript sentences. Code displays their full original fragments, actual speakers and source references so nearby qualifiers and commitments remain visible. A second model self-audit is not used as proof of support. Sentence identity does not prove that the selection answers the question; relevance, qualifiers and later corrections still need review. Test opposing views, explicit refusals, quoted malicious instructions, unknown task owners and dates. An explicit statement that no owner or date was agreed is a supported negative answer; a generic warning not to guess is not evidence that a particular fact is absent.

Test distant later corrections in long Meetings. Retrieval carries bounded late original-fragment context into reductions, but a newer unrelated task must not erase another commitment. Include both targeted and broad questions, because broad scans visit all passages and may require more calls or return a budget limitation. Keep verification abstention, incomplete review, structural/transport failure and a completed review finding no support separate. None of those limitations counts as correctly answering an answerable critical question.

Record Summary, chat and retrieval prompt versions alongside the source commit and dirty-state metadata. A successful earlier run is not a quality result for a later prompt. Extended evaluation deadlines must be labeled and cannot satisfy the production Summary's 15-minute gate. Automated checks, agent source inspection, independent human review and actual Mac measurements remain separate. Final CI status must be read from the final PR head.

## Target Mac acceptance checklist

Run these checks against the final code and prepared models. Record the app commit, device, model metadata, failures and which steps remain pending.

- [ ] Detection produces a Prompt for the actual Meeting app; acceptance starts Recording and manual Stop ends it. A decline discards the pre-buffer. Verify native permissions survive relaunch.
- [ ] A real Recording produces an English Transcript with both tracks aligned. Correct representative excerpts and compare recognition and speaker attribution. Review every passage supporting a critical decision; overlapping voices remain a known limitation.
- [ ] Summary contains a concise TL;DR and accurate per-Participant points, preserving proposals, disagreements and later changes. Human review finds at least 90% of expected important points, every critical final decision, no critical unsupported decision or owner, no invented labels and no invalid references.
- [ ] TL;DR and point timestamps open, scroll to and highlight the correct Transcript segments with audio already deleted. Rename a Participant, check names in Summary/Transcript/chat and export Markdown. Original spoken text stays unchanged.
- [ ] Ask targeted, absent-answer, follow-up and broad questions. Every predefined answerable critical question is correct with support; no critical unsupported claim or cross-Meeting evidence appears. An incomplete evidence scan must not be presented as an exhaustive absence finding.
- [ ] Chat remains available after Summary failure when a complete Transcript exists. Send, cancel, retry and clear work. Switch Meetings while an answer or reference lookup is pending; the result stays with its original Meeting.
- [ ] Restart restores complete history and marks unfinished requests interrupted. Summary regeneration and renaming preserve history. Transcript replacement clears old chat/evidence. Deleting a Meeting removes its records and retained audio; late results cannot recreate them.
- [ ] Run the reserved 10- and 60-minute examples only after tuning is fixed. Label any subsequent retuning. Synthetic length does not replace the real 60-minute check.
- [ ] On the M4, warm targeted answers finish within 60 seconds, broad scans within five minutes, and the real 60-minute Summary within 15 minutes. Record cold runs separately. The complete flow finishes without out-of-memory failure; report sampled RSS, Activity Monitor pressure and swap observations with their limits.
- [ ] After all assets are prepared, disconnect networking and repeat Recording → Transcript → Summary → targeted and broad chat. Restore the network only after recording the outcome. Offline acceptance requires an actual native-app run.
- [ ] Repeat unavailable Ollama, missing model, timeout, cancellation, invalid-output, engine-exit and interrupted-restart cases. Confirm useful recovery, preserved prior Summary and responsive Recording/Detection during queued AI work. Automated fake-model failures and actual device failures should be reported separately.

If a quality or performance gate fails, keep it failed or pending, fix the cause and rerun the affected examples. Do not substitute a successful smaller fixture for the failing real Meeting.

## Recover from failures

| What happened | Recovery |
| --- | --- |
| Ollama unavailable | Start local Ollama, check it in Settings, then regenerate the Summary or retry the question. |
| Configured text model missing | Pull the exact model named in the error, check Settings again and retry. An installed model with a different tag is not silently substituted. |
| Speech/speaker preparation fails | Check local disk space and connectivity for model downloads, restart the app and retry preparation in Settings. Existing downloads are retained. Repeat an actual transcription before claiming offline readiness. |
| Summary times out or output fails validation | Retry with Regenerate Summary after checking model readiness and memory. The previous successful Summary remains. Repeated failure is an evaluation failure to investigate, not a reason to publish partial output. |
| Chat returns a verification or evidence-budget limitation | Inspect the cited/available Transcript and ask a narrower question. Do not interpret abstention as proof of absence or as a correctly answered critical question. |
| Chat fails, is cancelled or interrupted | Use Retry to create a fresh request. Earlier completed messages remain. Clear chat removes that Meeting's history and cancels its work. |
| Speech-model release fails or engine exits | Restart the app before retrying. The AI queue must not start Gemma before native models are released. Saved Transcripts permit Summary regeneration; do not assume failed native audio can be recreated. |
| Transcription fails with retained tracks | The core supports retry from saved audio; the current Meetings UI does not expose a transcription-retry button. Keep the tracks and use a development recovery route, or record a new Meeting. Do not delete the Meeting while attempting recovery. |
| macOS permission denied or revoked | Follow the explanation in Settings, grant the affected permission in macOS settings, check again and restart if macOS requests it. Re-test the actual Meeting app. |
| Model memory pressure | Close unrelated heavy applications, wait for speech-model release, inspect Ollama residency and retry. Measure again on the M4; a Linux run cannot clear this gate. |

The bundle identifier remains `dev.bnd.meetingrecorder`. Keep packaging/signing and permission identity stable during the demo; rebuilding with a different signing identity can affect permissions independently of AI quality.
