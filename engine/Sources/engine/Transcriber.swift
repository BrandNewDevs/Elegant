// Runs WhisperKit over a Recording's two tracks and returns the Transcript's segments.
// English only, one batch after the Meeting. See docs/research/whisperkit.md for why each option is set as it is.
import Foundation
import WhisperKit

enum TranscriptionError: Error, CustomStringConvertible {
    case unreadable(String)
    case tracksDiffer(mic: Int, system: Int)

    var description: String {
        switch self {
        case .unreadable(let why): return "cannot read the audio: \(why)"
        case .tracksDiffer(let mic, let system):
            return "the two tracks differ in length (\(mic) and \(system) samples), but the Recording should have aligned them"
        }
    }
}

/// How far apart the tracks' lengths may be, in samples, before the Recording counts as misaligned (10 ms).
let trackLengthTolerance = outputSampleRate / 100

/// Holds the loaded model between Recordings and runs one transcription at a time.
actor Transcriber {
    private var kit: WhisperKit?
    private var loadedModel: String?

    /// `model` is a WhisperKit variant name; models and tokenizers are kept under `modelsDirectory`.
    func transcribe(micPath: String, systemPath: String, model: String, modelsDirectory: URL) async throws -> [TranscriptSegment] {
        let mic = try loadTrack(micPath)
        let system = try loadTrack(systemPath)
        guard abs(mic.count - system.count) <= trackLengthTolerance else {
            throw TranscriptionError.tracksDiffer(mic: mic.count, system: system.count)
        }

        let micRegions = speechRegions(in: mic)
        let systemRegions = speechRegions(in: system)
        // Nothing to recognise, so there is no reason to load the model (which may need a download) at all.
        if micRegions.isEmpty && systemRegions.isEmpty { return [] }

        let kit = try await loadedKit(model: model, modelsDirectory: modelsDirectory)
        return mergeTracks(
            mic: try await recognise(mic, regions: micRegions, with: kit),
            system: try await recognise(system, regions: systemRegions, with: kit)
        )
    }

    private func loadTrack(_ path: String) throws -> [Float] {
        do { return try AudioProcessor.loadAudioAsFloatArray(fromPath: path) }
        catch { throw TranscriptionError.unreadable("\(path): \(error)") }
    }

    private func recognise(_ samples: [Float], regions: [SpeechRegion], with kit: WhisperKit) async throws -> [RecognisedSegment] {
        // An empty list of clips means "the whole file" to WhisperKit, so a track with no speech must not get that far.
        guard !regions.isEmpty else { return [] }
        let options = DecodingOptions(
            task: .transcribe,
            language: "en",
            skipSpecialTokens: true,
            withoutTimestamps: false,
            wordTimestamps: false,
            clipTimestamps: regions.flatMap { [Float($0.start), Float($0.end)] }
        )
        let results = try await kit.transcribe(audioArray: samples, decodeOptions: options)
        let segments = results.flatMap(\.segments).map {
            RecognisedSegment(start: Double($0.start), end: Double($0.end), text: $0.text, compressionRatio: Double($0.compressionRatio))
        }
        return constrain(segments, to: regions)
    }

    /// Downloads `model` if it is not here yet and loads it, so the first Recording does not wait for either.
    /// `progress` gets the download's fraction, from 0 to 1.
    func prepare(model: String, modelsDirectory: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        _ = try await loadedKit(model: model, modelsDirectory: modelsDirectory, progress: progress)
    }

    private func loadedKit(model: String, modelsDirectory: URL, progress: (@Sendable (Double) -> Void)? = nil) async throws -> WhisperKit {
        if let kit, loadedModel == model { return kit }
        log("preparing speech model \(model); the first time this downloads it and can take minutes")
        let folder = try await WhisperKit.download(variant: model, downloadBase: modelsDirectory) { downloaded in
            log("downloading \(model): \(Int(downloaded.fractionCompleted * 100))%")
            progress?(downloaded.fractionCompleted)
        }
        let config = WhisperKitConfig(
            downloadBase: modelsDirectory,
            modelFolder: folder.path,
            tokenizerFolder: modelsDirectory,
            verbose: false,
            prewarm: true,
            load: true,
            download: false
        )
        let loaded = try await WhisperKit(config)
        kit = loaded
        loadedModel = model
        return loaded
    }
}

/// Progress for whoever runs the engine; stdout is reserved for protocol lines.
func log(_ message: String) {
    FileHandle.standardError.write(Data("[engine] \(message)\n".utf8))
}
