# WhisperKit for on-device Transcripts

Research for issue #7 ("Transcript with You and Others labels"). Read alongside [`design.md`](../design.md), [`ai-brief.md`](../ai-brief.md), [ADR 0001](../adr/0001-swift-engine-electron-ui.md), [ADR 0002](../adr/0002-fully-local-processing.md) and [`GLOSSARY.md`](../../GLOSSARY.md).

- **Date accessed:** 2026-10-24.
- **Version read:** `argmax-oss-swift` tag **v1.1.1** (released 2026-10-08), commit `1bbc57cb7fe6410248a685b1c5a3c6d56adc2ed4`. I read a shallow clone of that tag in a temp directory. Nothing was built or run.
- **Model repo read:** `argmaxinc/whisperkit-coreml` at commit `0f63a7800b00dd0226abd051b906c246e1907482` (last modified 2026-08-19).
- **Note on naming:** WhisperKit now lives in the repo `argmaxinc/argmax-oss-swift`. The old URL `argmaxinc/WhisperKit` redirects there. The library product is still called `WhisperKit`. [V]

Every claim is tagged **[V]** (Verified: read in the source or docs cited) or **[I]** (Inferred: my reasoning from what I read, not confirmed). Links are listed at the end under Sources; source-file citations give the file and line at tag v1.1.1.

## Summary

1. Use `argmax-oss-swift` v1.1.1, MIT, product `WhisperKit`. It has one real third-party package dependency (`swift-argument-parser`, used only by its CLI target). It has no bundled resources. It should build in a plain SwiftPM executable target, but I did not build it.
2. Feed it `[Float]` arrays (16 kHz mono, loaded with `AudioProcessor.loadAudioAsFloatArray`), not file paths, so the engine controls silence handling. Timestamps come back as seconds from the start of the array, 0.02 s resolution at segment level.
3. **`noSpeechThreshold` does nothing in v1.1.1**: the no-speech probability is hard-coded to 0 (`// TODO`). Silence hallucinations on the mostly-silent mic and system tracks therefore have to be handled by the engine: gate on energy before decoding, and filter the output afterwards.
4. **Segment text contains special and timestamp tokens by default** (`<|startoftranscript|><|0.00|> Hello<|2.50|>`). Set `skipSpecialTokens: true`.
5. Models are not bundled. They download from Hugging Face on first use, and the tokenizer is a second, separate download from `openai/whisper-*`. Core ML then compiles ("specializes") each model on first load, which has been reported to take minutes for the large models. Do that as an explicit first-run step with progress.
6. Candidate model: `large-v3-v20240930_626MB` (OpenAI large-v3-turbo, compressed, 627 MB, multilingual, forced to English). Fallback: `small.en` (487 MB). Final choice belongs to the WER evaluation in [`ai-brief.md`](../ai-brief.md).
7. Avoid `chunkingStrategy: .vad`: failed chunks are dropped silently, and we delete the audio after "success".

## 1. Current state

| Item | Finding |
|---|---|
| Latest release | v1.1.1, 2026-10-08. Previous: v1.1.0 (2026-08-06), v1.0.0 (2026-05-01), v0.18.0 (2026-04-01). [V] ([releases][rel-111], via `gh api repos/argmaxinc/WhisperKit/releases`) |
| License | MIT. [V] ([LICENSE][lic]; GitHub API `license.spdx_id` = `MIT`). Vendored Hugging Face `swift-transformers` Hub and Tokenizers code under `Sources/ArgmaxCore/External` is Apache 2.0 and listed in [NOTICES][notices]. [V] |
| Package name | `argmax-oss-swift`; products `ArgmaxOSS` (umbrella), `WhisperKit`, `TTSKit`, `SpeakerKit`, and executables `argmax-cli` / `whisperkit-cli`. [V] ([Package.swift][pkg] L16-L40) |
| Platforms | Manifest: `.macOS(.v13)` (also iOS 16, watchOS 10, visionOS 1). [V] ([Package.swift][pkg] L9-L14). README says "macOS 14.0 or later" and "Xcode 16.0 or later". [V] ([README][readme] "Prerequisites"). Our engine declares `.macOS(.v14)`, so it is compatible with either. The oldest OS in upstream CI is macOS 15 with Xcode 16.4, and macOS 14 was dropped from CI in v1.1.1 (PR [#545][pr545]). [V] |
| Swift tools version | `Package.swift` is tools 5.10. `Package@swift-6.2.swift` is tools 6.2 and is picked automatically by a Swift 6.2+ toolchain. It uses Swift 6 language mode and adds an `ArgmaxOSSDynamic` product. [V] ([Package.swift][pkg], [Package@swift-6.2.swift][pkg62], SwiftPM [version-specific manifests][spm-vs]) |
| Our tools version (5.9) | The dependency's tools version only has to be supported by the installed toolchain; SwiftPM treats a dependency whose tools version exceeds the toolchain as ineligible ([SwiftPM docs][spm-tools]). So the engine's `swift-tools-version:5.9` can stay, as long as the toolchain is 5.10 or newer. [I] (inferred from the docs; not tried) |
| Concurrency | The top-level `WhisperKit` class is not yet `Sendable` (v1.0.0 release notes). Keep one instance inside one actor or task. [V] ([v1.0.0 notes][rel-100]) |

### Adding it

The README snippet still says `from: "0.9.0"` (stale). Use the current package URL and version:

```swift
// engine/Package.swift
dependencies: [
    .package(url: "https://github.com/argmaxinc/argmax-oss-swift.git", .upToNextMinor(from: "1.1.1")),
],
targets: [
    .executableTarget(
        name: "engine",
        dependencies: [.product(name: "WhisperKit", package: "argmax-oss-swift")],
        path: "Sources/engine"
    ),
]
```

The package name and product name come from [Package.swift][pkg] L6-L40 [V]. The `.upToNextMinor` choice is mine; v1.0.0 was a breaking release and v1.1.x changed download behaviour. [I]

### Does it build in a plain SwiftPM executable target?

- The `WhisperKit` target declares no `resources:` and no plugins, so nothing needs Xcode's resource bundling. Models are fetched at runtime. [V] ([Package.swift][pkg] L66-L72)
- Upstream's own CLI is an `executableTarget` built with `swift build -c release --product argmax-cli` and run with `swift run argmax-cli ...`. [V] ([Makefile][makefile] L162-L172, README "Swift CLI")
- Upstream CI builds with `xcodebuild`, not bare `swift build`. [V] ([unit-tests.yml][ci])
- Conclusion: it should build with `swift build`. **Not verified on this machine.** The first real check is a spike that links `WhisperKit` into `engine` and runs `swift build`. [I]

### Transitive dependencies

- **Package dependencies:** only `swift-argument-parser` (`from: "1.3.0"`; `Package.resolved` pins 1.7.0; the 6.2 manifest requires `from: "1.7.0"`). It is used only by the `ArgmaxCLI` target, not by the `WhisperKit` library target. [V] ([Package.swift][pkg] L41-L43, [Package.resolved][resolved]). SwiftPM will probably still fetch it when resolving. [I]
- **Optional:** `vapor`, `swift-openapi-generator`, `swift-openapi-runtime` and `swift-openapi-vapor` are added only when the environment variable `BUILD_ALL` is `1` or `true` while the manifest is evaluated. Leave it unset. [V] ([Package.swift][pkg] L43-L50 and `isServerEnabled()`)
- **`swift-transformers` is gone.** Up to v0.18 it was a dependency; since v1.0.0 the Hub and Tokenizers sources are vendored into the `ArgmaxCore` target and exposed only through opaque wrappers. [V] ([v1.0.0 notes][rel-100])
- **Apple frameworks used by `WhisperKit` and `ArgmaxCore`:** CoreML, Accelerate, AVFoundation, AVFAudio, CoreAudio, NaturalLanguage, Network, CryptoKit, OSLog, CoreGraphics. [V] (grep of `import` lines under `Sources/WhisperKit` and `Sources/ArgmaxCore`)
- The same package also ships `SpeakerKit` (Pyannote-based speaker diarization, `Sources/SpeakerKit`). It is a candidate for the later "Speaker 1, Speaker 2" step in [`ai-brief.md`](../ai-brief.md) and needs no new package, but I did not evaluate it. [V] that it exists; [I] that it is relevant.

## 2. API

All signatures below were read in `Sources/WhisperKit/Core/` at v1.1.1. [V]

### Initialising

```swift
open class WhisperKit {
    public init(_ config: WhisperKitConfig = WhisperKitConfig()) async throws   // WhisperKit.swift L62
    open func loadModels(prewarmMode: Bool = false) async throws
    open func prewarmModels() async throws
    open func unloadModels() async
    public static func download(variant: String, downloadBase: URL? = nil,
        useBackgroundSession: Bool = false, from repo: String = "argmaxinc/whisperkit-coreml",
        token: String? = nil, endpoint: String = Constants.defaultRemoteEndpoint,
        progressCallback: ProgressCallback? = nil) async throws -> URL        // L253
}
```

`WhisperKitConfig` ([Configurations.swift][cfg] L5-L120) fields that matter: `model`, `downloadBase`, `modelRepo`, `modelToken`, `modelEndpoint`, `modelFolder`, `tokenizerFolder`, `computeOptions`, `voiceActivityDetector`, `verbose`, `logLevel`, `prewarm`, `load`, `download`, `useBackgroundDownloadSession`.

Behaviour of `init` ([WhisperKit.swift][wk] L62-L100):

- If `modelFolder` is set, no download happens and models load immediately. [V]
- Otherwise, if `download` is true (default), it downloads `model` (or the device default from the remote `config.json`). Models are **not** loaded at the end of `init`: `load` defaults to `config.modelFolder != nil`, which is false here. They load lazily on the first `transcribe` call (L1133), or when you call `loadModels()`. [V]
- `prewarm: true` loads and discards each model in turn before the final load, to trigger Core ML compilation with lower peak memory. The doc comment says the cost is about 2x load time when the compile cache is already warm. [V] ([Configurations.swift][cfg] L44-L74)
- Default compute units: mel on `.cpuAndGPU`; audio encoder and text decoder on `.cpuAndNeuralEngine` (encoder falls back to `.cpuAndGPU` before macOS 14). [V] ([Models.swift][models] L92-L118)

### Transcribing

```swift
// array, the main entry point (WhisperKit.swift L1017)
open func transcribe(audioArray: [Float], decodeOptions: DecodingOptions? = nil,
    callback: TranscriptionCallback? = nil,
    segmentCallback: SegmentDiscoveryCallback? = nil) async throws -> [TranscriptionResult]

// file (L919)
open func transcribe(audioPath: String, audioInputOptions: AudioInputOptions? = nil,
    decodeOptions: DecodingOptions? = nil,
    callback: TranscriptionCallback? = nil) async throws -> [TranscriptionResult]

// batches, per-item Result so one failure does not hide the others (L786)
open func transcribeWithResults(audioArrays: [[Float]], decodeOptions: DecodingOptions? = nil,
    callback: TranscriptionCallback? = nil) async -> [Result<[TranscriptionResult], Swift.Error>]
```

The `audioArray` doc comment says "Array of 16khz raw float audio samples". [V] The old `TranscriptionResult?`-returning overloads were removed in v1.0.0. [V] ([v1.0.0 notes][rel-100])

A 16 kHz mono file is read as-is with no resampling (`AudioProcessor.swift` L309); anything else is resampled through `AVAudioConverter`. `AudioProcessor.loadAudioAsFloatArray(fromPath:channelMode:startTime:endTime:) throws -> [Float]` is public (L340). [V] ([AudioProcessor.swift][audioproc]). Our `mic.wav` and `system.wav` are already 16 kHz mono, which avoids the resample path. Open issue [#500][i500] reports silent corruption in that resample path for an 87-minute mp3 on 0.18.0 (16 kHz mono WAV was fine). [V] that the report exists; not re-tested at 1.1.1.

### Result types ([Models.swift][models])

```swift
open class TranscriptionResult: Codable, @unchecked Sendable {        // L447
    var text: String; var segments: [TranscriptionSegment]
    var language: String; var timings: TranscriptionTimings; var seekTime: Float?
}
public struct TranscriptionSegment: Hashable, Codable, Sendable {      // L574
    var id: Int; var seek: Int            // seek is in samples
    var start: Float; var end: Float      // seconds
    var text: String; var tokens: [Int]; var tokenLogProbs: [[Int: Float]]
    var temperature: Float; var avgLogprob: Float; var compressionRatio: Float
    var noSpeechProb: Float               // always 0 in v1.1.1, see section 5
    var words: [WordTiming]?              // only with wordTimestamps: true
}
public struct WordTiming: Hashable, Codable, Sendable {                // L622
    var word: String; var tokens: [Int]; var start: Float; var end: Float
    var probability: Float
}
```

`TranscriptionResult.allWords` flattens `segments[].words`. [V] ([Models.swift][models] L566-L570)

### Decoding options ([Configurations.swift][cfg] L162-L254)

Defaults that matter for us:

| Option | Default | Note |
|---|---|---|
| `language` | `nil` | See "English" below. |
| `task` | `.transcribe` | |
| `usePrefillPrompt` | `true` | Forces the start-of-transcript, language, task and timestamp tokens. |
| `detectLanguage` | `!usePrefillPrompt` = `false` | No detection by default. |
| `skipSpecialTokens` | **`false`** | Special and timestamp tokens stay in `segment.text`. |
| `withoutTimestamps` | `false` | Needed for segment timings. |
| `wordTimestamps` | `false` | |
| `temperature` / `temperatureIncrementOnFallback` / `temperatureFallbackCount` | 0.0 / 0.2 / 5 | |
| `compressionRatioThreshold` | 2.4 | |
| `logProbThreshold` | -1.0 | |
| `firstTokenLogProbThreshold` | -1.5 | |
| `noSpeechThreshold` | 0.6 | Has no effect, see section 5. |
| `suppressBlank` | `false` | OpenAI's default is true. |
| `suppressTokens` | `[]` | A TODO in the source says the non-speech default is not implemented. |
| `windowClipTime` | 1.0 s | Skips the last second of a clip "to help prevent hallucinations". |
| `clipTimestamps` | `[]` | Pairs of seconds `[start, end, ...]`; empty means the whole file. |
| `concurrentWorkerCount` | 16 on macOS | Parallelism for batches and VAD chunks. |
| `chunkingStrategy` | `nil` | `ChunkingStrategy` is `.none` or `.vad`. |
| `promptTokens` | `nil` | No conditioning on previous text unless you pass it. |

### Forcing English

- With a multilingual model (all the `large-v3*`, `small`, `base`, `tiny`), the prefill uses `options.language ?? Constants.defaultLanguageCode`, and `defaultLanguageCode` is `"en"`. Language detection runs only if `language == nil` **and** `detectLanguage == true`, which is not the default. So the default is already English, but set `language: "en"` explicitly. [V] ([TextDecoder.swift][txtdec] L181-L185, [TranscribeTask.swift][tt] L341, [Models.swift][models] L1459)
- With an English-only model (`*.en`), no language token is used at all. [V] ([TextDecoder.swift][txtdec] L181 `if isModelMultilingual`)
- A multilingual model decoding English with the English token forced can still emit non-English text on very noisy input. [I]

### Long audio

- `transcribe(audioArray:)` splits only if the array is longer than 30 s (`windowSamples`, 480,000 samples at 16 kHz). [V] ([WhisperKit.swift][wk] L1027)
- **Default (`chunkingStrategy == nil`):** one sequential pass. `TranscribeTask.run` decodes 30 s windows; after each window it seeks to the end of the last segment found, and the loop continues while `seek < clipEnd - 1.0 s`. It throws on failure. It returns one `TranscriptionResult` whose `segments` span the whole file. [V] ([TranscribeTask.swift][tt] L103-L260)
- **`.vad`:** an energy-based VAD (`EnergyVAD`, RMS threshold 0.02 per 100 ms frame) picks split points in silence so that chunks are at most 30 s. It only chooses cut points; the chunks cover the whole audio, so silent chunks are still decoded. Chunks are then transcribed in parallel (up to `concurrentWorkerCount`) and you get one `TranscriptionResult` per chunk. **A failed chunk is only logged and dropped.** [V] ([AudioChunker.swift][chunker] L34-L36 and `VADAudioChunker`; [EnergyVAD.swift][energyvad]; [WhisperKit.swift][wk] L1027-L1060)
- **Incremental loading** (`AudioInputOptions(audioLoadingMode: .incremental)`, since v1.1.0) streams a file from disk in 120 s chunks cut at silence. It exists to avoid out-of-memory on multi-hour audio. [V] ([v1.1.0 notes][rel-110], README "Memory-Efficient Loading"). Not needed for us: a one-hour 16 kHz mono Float32 array is about 230 MB. [I] (arithmetic: 3600 s x 16000 x 4 bytes)
- The last second of audio may be skipped (`windowClipTime`), and a clip shorter than 1 s is never decoded. [V] (loop condition at [TranscribeTask.swift][tt] L113-L120)

### Timestamp units and offsets

- All `start`/`end` values are `Float` **seconds from the first sample of the array you passed**. They are already absolute across windows and chunks: segment times are `window offset + timestamp token x 0.02 s`, and chunked/streamed results have the chunk's seek offset added by `TranscriptionUtilities.updateSegmentTimings`. [V] ([SegmentSeeker.swift][seeker] L109-L135, [TranscriptionUtilities.swift][tu] L57-L92, `WhisperKit.secondsPerTimeToken = 0.02` at [WhisperKit.swift][wk] L46)
- `segment.seek` is in samples, not seconds. [V]
- Word times come from cross-attention alignment plus dynamic time warping (`wordTimestamps: true`), in the same time base, rounded to 0.01 s. Source comments mark parts of it as ports of OpenAI "hacks". It requires the decoder to return alignment weights, which the shipped models do. [V] ([SegmentSeeker.swift][seeker] L410 `addWordTimestamps`, [TranscribeTask.swift][tt] L196-L230)
- A segment with no usable consecutive timestamp tokens becomes one segment covering the window (or up to the last timestamp seen). [V] ([SegmentSeeker.swift][seeker] L139-L180)

## 3. Models

### Download and storage

- Repo `argmaxinc/whisperkit-coreml` on Hugging Face (MIT per its card, not gated). Each variant is a folder `openai_whisper-<name>/` (or `distil-whisper_<name>/`) holding `AudioEncoder.mlmodelc`, `TextDecoder.mlmodelc`, `MelSpectrogram.mlmodelc`, `config.json`, `generation_config.json`. **No tokenizer files are in this repo.** [V] ([HF API listing][hf-api], [repo card][hf-card])
- `WhisperKit.download(variant:...)` lists files matching `*<variant>/*` and fetches the matching folder from revision `main` (not pinned). A short name like `large-v3-v20240930_626MB` must match exactly one folder, otherwise it throws. [V] ([WhisperKit.swift][wk] L253-L320)
- Default location is `<downloadBase>/models/argmaxinc/whisperkit-coreml/<variant>/`. If `downloadBase` is nil, `downloadBase` is **`~/Documents/huggingface`**. Set `downloadBase` yourself. [V] ([HubApi.swift][hub] L105-L110 and L333-L335)
- Progress: `download(... progressCallback:)` hands you a Foundation `Progress` (`fractionCompleted`; the throughput is in `userInfo[.throughputKey]` at the Hub level). The callback can fire on any thread. `WhisperKit.init` has no progress parameter. [V] ([Models.swift][models] ProgressCallback doc, [WhisperKit.swift][wk] L253-L300)
- Resume and repair: each file is checked against its stored etag/hash metadata. Cancelling now throws `CancellationError` instead of returning a partial folder (v1.1.1). [V] ([v1.1.1 notes][rel-111], [HubApi.swift][hub] L560-L640). Open issue [#491][i491] (partial downloads never repaired) concerns TTSKit's `ModelDownloader`, not this path. [V] that the WhisperKit path calls `hubApi.snapshot` directly.
- **Tokenizer is a second download.** After loading, WhisperKit looks for `tokenizer.json` under `<tokenizerFolder>/models/openai/whisper-<size>[.en]`, then in `tokenizerFolder`, then in the model folder. If none has it, it downloads `config.json`, `tokenizer_config.json`, `tokenizer.json` and chat-template files from `openai/whisper-<size>` on huggingface.co. `tokenizerFolder` defaults to `downloadBase`. So a model folder alone is **not** enough to run offline; the tokenizer must have been fetched once as well. [V] ([ModelUtilities.swift][modelutil] L14-L80 and `tokenizerNameForVariant`, [Hub.swift][hubswift] L229-L240)
- Offline: if the machine is offline, `snapshot` serves the local copy but recomputes SHA-256 of every file in the requested glob, which for a 600 MB model is a noticeable pause on every load. When online it makes network calls (file list, metadata) each time. [V] ([HubApi.swift][hub] L573-L640)
- To avoid both, pass `modelFolder:` and `tokenizerFolder:` with `download: false`. Then no Hub call happens at transcription time, except the tokenizer fetch if it was never cached. [V] ([WhisperKit.swift][wk] L62-L100, [ModelUtilities.swift][modelutil])
- Env vars read by the Hub client: `HF_ENDPOINT` (redirects all downloads) and `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN`. Since v1.1.1 it no longer reads token files from disk. [V] ([HubApi.swift][hub] L127-L140, [v1.1.1 notes][rel-111])

### Variants and sizes

Sizes are the sum of file sizes in the Hugging Face listing (`siblings[].size`, 2026-10-24, repo commit `0f63a78`). [V] ([HF API listing][hf-api]) Parameter counts and VRAM are OpenAI's PyTorch figures, not Core ML. [V] ([Whisper README][whisper-readme])

| Folder (after `openai_whisper-` unless noted) | Download | Language | Notes |
|---|---|---|---|
| `tiny.en` | 153 MB | English | Folder contains both `.mlmodelc` and `.mlpackage` copies, hence 2x the multilingual `tiny` (77 MB). README: "only recommended for development & debugging". |
| `base.en` | 147 MB | English | |
| `small.en` | 487 MB | English | OpenAI: 244 M params, ~2 GB VRAM. |
| `small.en_217MB` | 218 MB | English | Compressed. |
| `medium.en` | 1.53 GB | English | OpenAI: 769 M params, ~5 GB VRAM. |
| `large-v3-v20240930_626MB` | 627 MB | Multilingual | OpenAI large-v3-turbo ("v20240930"), compressed. README: "Recommended across iOS and macOS for maximum accuracy". |
| `large-v3-v20240930` | 1.62 GB | Multilingual | Same model, uncompressed. This is the remote default for M2/M3/M4 Macs. |
| `large-v3-v20240930_turbo`, `_turbo_632MB` | 1.64 GB, 646 MB | Multilingual | README: `large-v3-v20240930_turbo` is "recommended on macOS for maximum speed and accuracy". The README does not explain the suffix; do not confuse it with OpenAI's "turbo". |
| `distil-whisper_distil-large-v3_594MB` (also 1.51 GB uncompressed) | 595 MB | **English only** | Distilled large-v3. Its card claims within 1% WER of large-v3 on long-form and 6.3x faster than large-v3. [V] ([card][distil]) |
| `large-v3` (3.09 GB), `large-v3_947MB` (948 MB), `large-v2*` | | Multilingual | Not needed. |

OpenAI says the `.en` models "tend to perform better, especially for `tiny.en` and `base.en`", with the difference smaller for `small.en` and `medium.en`; there is no `.en` large or turbo model. The OpenAI turbo model "offers faster transcription speed with a minimal degradation in accuracy" versus large-v3. [V] ([Whisper README][whisper-readme])

### Recommended models per device (documented by WhisperKit)

`WhisperKit.recommendedRemoteModels()` reads the remote `config.json` and matches the Mac model identifier. For `Mac14`, `Mac15`, `Mac16` ("M2, M3, M4") the default is `openai_whisper-large-v3-v20240930` and every variant in the table above is listed as supported. For M1 the default is `openai_whisper-large-v3-v20240930_626MB`. Phone-class chips get `tiny`/`base`. [V] ([config.json][hf-config], [WhisperKit.swift][wk] L162-L250; the in-code fallback at [Models.swift][models] L1471 matches)

Argmax's README note: "Argmax recommends `large-v3-v20240930_626MB` for maximum multilingual accuracy and `tiny` for the fastest debugging workflow." [V] ([README][readme] "Model Selection")

### What fits a 16 GB M4

- There is no WhisperKit-published memory figure that I could find. [V] (searched README, BENCHMARKS.md, docs; Argmax benchmarks live in a Hugging Face space I did not read)
- Every candidate above is a few hundred MB to 1.6 GB of weights, and WhisperKit lists all of them as supported on M4. With the 30 s window and one decoder KV cache, I expect runtime memory of a few GB at most, well under the 8 GB budget in [`ai-brief.md`](../ai-brief.md). [I] **Measure it** on the target machine; OpenAI's "~6 GB VRAM" for turbo is a PyTorch upper bound, not Core ML.
- One caveat: `VADAudioChunker` plus `concurrentWorkerCount = 16` runs many windows in parallel against one model instance, which raises memory and was not measured. Another reason not to use `.vad`. [I]

## 4. Sandboxing, entitlements and the Core ML first load

- **Network.** The model, the tokenizer and the model-list `config.json` come from `huggingface.co`, and the file downloads redirect to a `*.hf.co` CDN host (observed on a `HEAD` request on 2026-10-24: a 302 to `us.aws.cdn.hf.co`). [V] An outgoing-connection entitlement is needed only if the app is sandboxed: `com.apple.security.network.client` ([Apple][apple-net]). An Electron `.app` distributed outside the Mac App Store is normally not sandboxed, so I expect no entitlement is needed. [I] Nothing else in WhisperKit needs network at transcription time once the model and tokenizer are cached and `modelFolder`/`tokenizerFolder` are passed. [V]
- **Where to store models.** The default `~/Documents/huggingface` is a bad place for a menu-bar app. Set `downloadBase` to something under `~/Library/Application Support/<bundle id>/models`. [I] (Reading and writing `~/Documents` can trigger a macOS privacy prompt for a non-sandboxed app; I did not verify that for this case.)
- **Core ML specialization ("compile") on first load.** Per Argmax's own comment in [Configurations.swift][cfg] L44-L74 [V]: the downloaded `*.mlmodelc` files are device-agnostic and must be "specialized" to the chip. Core ML does this on first load and caches the result outside the app bundle; "this cache is maintained by Apple and is evicted after every OS update and if the models are not used for extended periods"; there is no API to check whether it will hit. Hence the `prewarm` option.
- **How long.** Not documented by Argmax. User reports in the issue tracker: `openai_whisper-large-v3-v20240930_turbo` took **440 s on an M4 Pro** (macOS 15.3.1) and 560 s on an M2 Pro, then 3-5 s on later loads ([#309][i309]); about 10 minutes for `..._turbo_632MB` on an M1 Pro ([#268][i268]); tiny loaded much faster than the large models. [V] that these reports exist; they are one-off user numbers on older macOS releases and I could not confirm them. Budget for "minutes" on first run, and again after a macOS update. [I]
- **Where the cache lives.** Not stated in the source I read. Do not rely on a path. [V] (absence)
- **Embedding in the Electron bundle.** WhisperKit is a static SwiftPM library by default (the dynamic `ArgmaxOSSDynamic` product is opt-in), so the engine binary needs no extra frameworks or dylibs to ship. [V] ([Package.swift][pkg62]) Hardened-runtime signing needs no JIT or unsigned-memory entitlements for Core ML, as far as I can tell. [I] (The relevant Apple key, `com.apple.security.cs.allow-jit`, is for apps that create writable-executable memory ([Apple][apple-jit]); I saw nothing in WhisperKit that does.) The detection prototype already showed a Swift helper can run inside a bundle with identifier `dev.bnd.elegant` ([`design.md`](../design.md)). Whether Core ML's cache is keyed to that bundle or to the helper binary, and so survives rebuilds and re-signing, is untested. [I]
- **No microphone or system-audio permission** is involved in file transcription; those belong to capture. [I]

## 5. Known pitfalls

### Hallucinations on silence

Both tracks will be mostly silent: `mic.wav` while Others talk, `system.wav` while you talk.

- **`noSpeechThreshold` is inert.** `TextDecoder.decodeText` sets `let noSpeechProb: Float = 0 // TODO: implement no speech prob` ([TextDecoder.swift][txtdec] L821). The skip logic in `SegmentSeeker` (`decodingResult.noSpeechProb > threshold`, L57-L70) and in `DecodingFallback` ([Models.swift][models] L366-L370) therefore never fires. The feature is tracked in open issue [#27][i27] (since 2024). In OpenAI's Whisper the value is the probability of `<|nospeech|>` at the first step ([decoding.py][oa-decoding] L683-L710). [V]
- **The other thresholds only trigger a retry, and the retry can still be accepted.** `compressionRatioThreshold` (2.4), `logProbThreshold` (-1.0) and `firstTokenLogProbThreshold` (-1.5) set `needsFallback`; `decodeWithFallback` then re-decodes at temperature +0.2, up to 5 times (so up to 6 decodes per window), and returns the **last** result whatever it is ([TranscribeTask.swift][tt] L316-L412). A silent window can therefore be both slow and wrong. [V]
- **WhisperKit's VAD does not skip silence.** `.vad` chunking only chooses cut points; silent chunks are still decoded (see section 2). There is no equivalent of OpenAI's `hallucination_silence_threshold` in WhisperKit (grep found nothing). [V]
- **No previous-text conditioning** unless you pass `promptTokens`, which removes one common cause of repetition loops (OpenAI's `condition_on_previous_text`). [V] ([TextDecoder.swift][txtdec] L196-L203)
- **Do not enable `suppressBlank`.** It forbids the end-of-text token as the first sample (L887 and `SuppressBlankFilter`), which forces output on silent windows. [V] for what the filter does; [I] that it would make silence hallucinations worse.
- What a silent window looks like in practice: issue [#109][i109] shows `[0.00 --> 30.00] <|startoftranscript|><|nocaptions|><|endoftext|>` for audio the model judged empty. With `skipSpecialTokens: true` that becomes an empty string. [V] that it was reported (v0.x era). Models can also emit plain-text sound tags: `[BLANK_AUDIO]` is common in whisper.cpp output ([whisper.cpp #2420][wcpp2420], on `medium.en`). It does not appear anywhere in WhisperKit's source (grep), so it can only arrive as model text. [V] Other typical hallucinations on silence ("Thank you.", "you", "(music)") are well known from experience but I did not find a primary source to cite. [I]
- Open issue [#528][i528] (2026-08) reports skipped sentences and hallucinations with large-v2, with no resolution yet. [V] that it exists.

### Special tokens and timestamp markers in text

- **`TranscriptionSegment.text` includes them by default.** `SegmentSeeker` builds segment text with `tokenizer.decode(tokens:)` over all of the segment's tokens unless `skipSpecialTokens` is true ([SegmentSeeker.swift][seeker] L119-L121 and L163-L165). `decode(tokens:)` does not drop special tokens ([Tokenizer.swift][tokenizer] L305 and L510). So you get things like `<|startoftranscript|><|0.00|> blah blah<|1.08|><|endoftext|>`, exactly as reported in [#353][i353] (fixed there with `--skip-special-tokens`). The first segment of each window also carries the prefill tokens (`<|startoftranscript|>`, `<|en|>`, `<|transcribe|>`). [V]
- **`TranscriptionResult.text` is already clean:** `finalizeTranscriptionResult` drops tokens at or above `specialTokenBegin` ([TranscribeTask.swift][tt] L303-L312). So per-segment text and the joined text disagree unless you set the flag. [V]
- With `skipSpecialTokens: true` the filter is `token < specialTokenBegin` (the `<|endoftext|>` id), which removes all special, language, task and timestamp tokens. [V]
- Timestamp tokens look like `<|12.34|>` (0.02 s steps, 0.00 to 30.00). Safety net regex if the flag is ever off: `<\|[^|]*\|>`. [V] for the format ([SegmentSeeker.swift][seeker]); [I] for the regex.
- Segment text usually begins with a space; trim it. [I]
- Strip bracketed or parenthesised sound tags that make up a whole segment, for example `^\s*[\[\(][^\]\)]{0,40}[\]\)]\s*$` (`[BLANK_AUDIO]`, `(silence)`, `[Music]`), and drop segments whose trimmed text is empty. This is a heuristic to tune on real Recordings. [I]

### Other

- The final second of each decoded clip may be skipped (`windowClipTime = 1.0`), and audio shorter than 1 s produces no segments. [V]
- **`.vad` drops failed chunks silently** ([AudioChunker.swift][chunker] L34-L36), which would produce a partial Transcript marked successful. [V]
- `WhisperKit` is not `Sendable`; keep it in one actor. [V]
- Segment timestamps are model-predicted at 0.02 s resolution and can be off by a few tenths of a second (issue [#105][i105], closed). Fine for ordering; do not use them for sample-accurate alignment between tracks. [V] that it was reported; [I] for the advice.
- The model repo is read from `main`, so a model update upstream can change a fresh install without any app change. There is no revision parameter on `WhisperKit.download`. [V] ([WhisperKit.swift][wk] L253-L300) Record the folder name and keep a copy if reproducibility matters. [I]

## 6. Alternatives (brief)

- **whisper.cpp** (MIT, v1.9.5 released 2026-10-06): C/C++ with ggml; Metal on the GPU, optional Core ML encoder on the ANE, built-in VAD ([README][wcpp]). Pick it if you need Silero-style VAD built in, GGUF/ggml quantisations, or a library without the Core ML compile step (its README also warns the first Core ML run is slow). Cost: you own the C interop and the build. Swift packaging exists (`whisper.spm`, XCFramework). [V]
- **MLX Whisper** (`mlx-whisper`, from `ml-explore/mlx-examples`): Python on Apple's MLX ([README][mlx]). Pick it for fast iteration on accuracy experiments (the Python side of [`ai-brief.md`](../ai-brief.md)), not for the shipped Swift engine, which would need a Python runtime. [V] that it is Python/pip; [I] on the recommendation.
- WhisperKit stays the default because it is Swift-native, Core ML on the ANE, and is already named in [`design.md`](../design.md). [I]

## 7. Recommended approach for issue #7

Everything here is a plan built on the facts above. [I] unless marked. None of it has been compiled or run.

### Model and options

- **Model:** start with `large-v3-v20240930_626MB`, forced English. Keep `small.en` as the fast fallback if first-load specialization or decode time is unacceptable. Make the model name a setting. Let the WER evaluation in [`ai-brief.md`](../ai-brief.md) decide; I have no accuracy data. If English-only is preferred, `distil-large-v3_594MB` is the other candidate to test.
- **Decode options:**
  ```swift
  DecodingOptions(
      task: .transcribe,
      language: "en",
      skipSpecialTokens: true,        // required, see section 5
      withoutTimestamps: false,
      wordTimestamps: false,          // segment timing is enough for #7
      chunkingStrategy: nil           // sequential windows; throws on failure
  )
  ```
  Leave the fallback thresholds at their defaults, leave `suppressBlank` and `suppressTokens` alone, and do not pass `promptTokens`.
- **Compute:** defaults (`.cpuAndNeuralEngine` for encoder and decoder).

### First run (model download)

1. `WhisperKit.download(variant:downloadBase:progressCallback:)` with `downloadBase` under Application Support. Forward `Progress.fractionCompleted` to the app over the JSON-lines protocol.
2. Construct `WhisperKit(WhisperKitConfig(modelFolder: folder.path, tokenizerFolder: downloadBase, prewarm: true, load: true, download: false))` while online. This fetches the tokenizer and runs Core ML specialization. Report it as a separate step ("Preparing speech model, one-time, can take minutes").
3. Persist "model ready" only after step 2 succeeds. On later launches use the same config, offline. After a macOS update, expect specialization again.

### Per Recording

1. Load both files with `AudioProcessor.loadAudioAsFloatArray(fromPath:)` (no resampling for 16 kHz mono). Check both arrays have the same length (±1 frame); if not, mark the Meeting failed, since the contract says they match.
2. **Gate on speech per track** (the key mitigation, given `noSpeechThreshold` is inert):
   - Compute RMS per 100 ms frame. `EnergyVAD().calculateActiveChunks(in:)` does this with an absolute threshold of 0.02. That is probably too coarse for quiet voices, so use a threshold relative to the track's noise floor and tune on real Recordings.
   - Pad regions by about 0.3 s and merge regions separated by less than about 2 s, so windows are filled and the encoder runs fewer times (each decode window costs one 30 s encoder pass regardless of length).
   - Drop regions shorter than about 1 s (WhisperKit would skip them anyway).
   - If a track has **no** speech regions, skip it. An empty `clipTimestamps` means "the whole file" in WhisperKit, so never pass an empty list.
3. Transcribe each track sequentially with the same `WhisperKit` instance:
   - Pass the full array and set `clipTimestamps` to the flattened regions (`[s0, e0, s1, e1, ...]`, seconds). Segment times stay in the file's time base, so nothing needs offsetting.
   - Alternative if `clipTimestamps` misbehaves: transcribe each region's slice and add its start with `TranscriptionUtilities.updateSegmentTimings(segment:seekTime:)` (public).
4. `results.flatMap(\.segments)` (there is one result in the default mode, but flatten anyway).
5. **Clean:** trim, drop empty text, drop whole-segment bracketed sound tags, and drop or flag segments with `compressionRatio > 2.4` (repetition loops). Do not drop on `avgLogprob` alone.
6. **Map to the contract:** `{ start, end, speaker, text }` with `speaker = "You"` for `mic.wav` and `"Others"` for `system.wav` (the labels in issue #7; diarization later replaces `"Others"` with `"Speaker N"` per [`ai-brief.md`](../ai-brief.md)). `start`/`end` are seconds, rounded to 2 decimals.
7. **Merge and order:** concatenate both lists and sort by `(start, end)`. Overlapping speech is allowed, so do not try to resolve overlaps. The two tracks share a time base because the capture engine aligns them on host time before handing them over ([`design.md`](../design.md)).
8. **Success and failure:** write the Transcript JSON, then delete the audio. Any thrown error, a length mismatch or a missing model marks the Meeting failed with the audio kept, so the retry has something to work on. Because the default mode throws instead of dropping chunks, "no error" means no silently missing windows. [V] for the throwing behaviour.

### Segment or word timestamps?

Use **segment-level** for #7: it matches the output schema, costs less and avoids the alignment code path. Turn on `wordTimestamps` when diarization of `system.wav` arrives, to assign each word to a speaker turn and split segments at speaker changes. [I]

### Risks to check early (not verified)

1. `swift build` of `engine` with the `WhisperKit` product on the target toolchain.
2. First-load specialization time on the actual M4 for the 626 MB model, and whether it recurs after relaunch or rebuild of the embedded helper.
3. Peak memory and real-time factor for a long Recording, with the model you pick.
4. Whether the energy gate removes silence hallucinations without clipping quiet speech, and whether `clipTimestamps` behaves as read.
5. Echo: if you listen on speakers, `mic.wav` will contain Others, so "You" would repeat what Others said. WhisperKit does nothing about this. This is the acoustic-alignment risk already listed in [`design.md`](../design.md).
6. Accuracy of the compressed `_626MB` variant against the uncompressed `large-v3-v20240930`; Argmax calls it a compressed variant but I did not read its accuracy numbers.

## Sources

Date accessed for all: 2026-10-24. "Tag v1.1.1" means `https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/<path>`.

**WhisperKit / argmax-oss-swift, tag v1.1.1 (commit 1bbc57c)**

[pkg]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Package.swift
[pkg62]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Package@swift-6.2.swift
[resolved]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Package.resolved
[readme]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/README.md
[lic]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/LICENSE.md
[notices]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/NOTICES
[makefile]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Makefile
[ci]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/.github/workflows/unit-tests.yml
[wk]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/WhisperKit/Core/WhisperKit.swift
[cfg]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/WhisperKit/Core/Configurations.swift
[models]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/WhisperKit/Core/Models.swift
[tt]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/WhisperKit/Core/TranscribeTask.swift
[txtdec]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/WhisperKit/Core/TextDecoder.swift
[seeker]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/WhisperKit/Core/Text/SegmentSeeker.swift
[chunker]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/WhisperKit/Core/Audio/AudioChunker.swift
[energyvad]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/WhisperKit/Core/Audio/EnergyVAD.swift
[audioproc]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/WhisperKit/Core/Audio/AudioProcessor.swift
[tu]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/WhisperKit/Utilities/TranscriptionUtilities.swift
[modelutil]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/WhisperKit/Utilities/ModelUtilities.swift
[hub]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/ArgmaxCore/External/Hub/HubApi.swift
[hubswift]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/ArgmaxCore/External/Hub/Hub.swift
[tokenizer]: https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/ArgmaxCore/External/Tokenizers/Tokenizer.swift

**Releases, PRs, issues** (`argmaxinc/argmax-oss-swift`)

[rel-111]: https://github.com/argmaxinc/argmax-oss-swift/releases/tag/v1.1.1
[rel-110]: https://github.com/argmaxinc/argmax-oss-swift/releases/tag/v1.1.0
[rel-100]: https://github.com/argmaxinc/argmax-oss-swift/releases/tag/v1.0.0
[pr545]: https://github.com/argmaxinc/argmax-oss-swift/pull/545
[i27]: https://github.com/argmaxinc/argmax-oss-swift/issues/27
[i105]: https://github.com/argmaxinc/argmax-oss-swift/issues/105
[i109]: https://github.com/argmaxinc/argmax-oss-swift/issues/109
[i268]: https://github.com/argmaxinc/argmax-oss-swift/issues/268
[i309]: https://github.com/argmaxinc/argmax-oss-swift/issues/309
[i353]: https://github.com/argmaxinc/argmax-oss-swift/issues/353
[i491]: https://github.com/argmaxinc/argmax-oss-swift/issues/491
[i500]: https://github.com/argmaxinc/argmax-oss-swift/issues/500
[i528]: https://github.com/argmaxinc/argmax-oss-swift/issues/528

**Model repos**

[hf-card]: https://huggingface.co/argmaxinc/whisperkit-coreml
[hf-config]: https://huggingface.co/argmaxinc/whisperkit-coreml/blob/main/config.json
[hf-api]: https://huggingface.co/api/models/argmaxinc/whisperkit-coreml?blobs=true (file listing and sizes, commit `0f63a78`)
[distil]: https://huggingface.co/distil-whisper/distil-large-v3 (README, commit `8031d2e`)

**OpenAI Whisper** (main at `8609812`)

[whisper-readme]: https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/README.md
[oa-decoding]: https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/whisper/decoding.py
(`transcribe.py` at the same commit documents `no_speech_threshold`, `logprob_threshold`, `condition_on_previous_text`, `hallucination_silence_threshold` and `clip_timestamps`.)

**Apple and SwiftPM**

[apple-net]: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.network.client
[apple-jit]: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit
[spm-vs]: https://github.com/swiftlang/swift-package-manager/blob/main/Sources/PackageManagerDocs/Documentation.docc/SwiftVersionSpecificPackaging.md
[spm-tools]: https://github.com/swiftlang/swift-package-manager/blob/main/Sources/PackageManagerDocs/Documentation.docc/SettingSwiftToolsVersion.md

**Alternatives**

[wcpp]: https://github.com/ggml-org/whisper.cpp/blob/master/README.md (release v1.9.5, MIT)
[wcpp2420]: https://github.com/ggml-org/whisper.cpp/issues/2420
[mlx]: https://github.com/ml-explore/mlx-examples/blob/main/whisper/README.md
