// Turns the speech recognised on each track into one Transcript in the documented segment shape (docs/ai-brief.md).
// Pure functions on plain values, so it is tested without a model or any audio.
import Foundation

/// A segment as recognised on one track, before it is labelled.
struct RecognisedSegment: Equatable {
    var start: Double
    var end: Double
    var text: String
    /// Whisper's gzip compression ratio for the segment; a high value marks a repetition loop.
    var compressionRatio: Double = 1
}

/// A segment of the stored Transcript. Encodes to `{ "start", "end", "speaker", "text" }`.
struct TranscriptSegment: Codable, Equatable {
    var start: Double
    var end: Double
    var speaker: String
    var text: String
}

let micSpeaker = "You"
let systemSpeaker = "Others"

/// Above this a segment is a repetition loop, not speech (Whisper's own default threshold).
let maxCompressionRatio = 2.4

/// Labels each track's segments, drops what is not speech, and orders the result by start time.
/// Overlapping segments are kept: people do talk over each other.
func mergeTracks(mic: [RecognisedSegment], system: [RecognisedSegment]) -> [TranscriptSegment] {
    let labelled = mic.compactMap { label($0, as: micSpeaker) } + system.compactMap { label($0, as: systemSpeaker) }
    return labelled.sorted(by: inOrder)
}

private func label(_ segment: RecognisedSegment, as speaker: String) -> TranscriptSegment? {
    guard segment.compressionRatio <= maxCompressionRatio else { return nil }
    let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !isSoundTag(text) else { return nil }
    return TranscriptSegment(start: roundToCentiseconds(segment.start), end: roundToCentiseconds(segment.end), speaker: speaker, text: text)
}

/// A whole segment that is a bracketed note such as `[BLANK_AUDIO]` or `(music)`, which the model emits for non-speech.
func isSoundTag(_ text: String) -> Bool {
    guard let first = text.first, let last = text.last else { return false }
    let inner = text.dropFirst().dropLast()
    let closer: Character
    switch first {
    case "[": closer = "]"
    case "(": closer = ")"
    default: return false
    }
    return last == closer && !inner.contains(where: { "[]()".contains($0) })
}

private func roundToCentiseconds(_ seconds: Double) -> Double { (seconds * 100).rounded() / 100 }

/// By start, then end. Segments that tie on both put You first, so the order never depends on the sort algorithm.
private func inOrder(_ a: TranscriptSegment, _ b: TranscriptSegment) -> Bool {
    if a.start != b.start { return a.start < b.start }
    if a.end != b.end { return a.end < b.end }
    return a.speaker == micSpeaker && b.speaker != micSpeaker
}

/// The Transcript as the JSON the app stores: `{ "segments": [...] }`.
func encodeTranscript(_ segments: [TranscriptSegment]) throws -> Data {
    struct Wire: Encodable { var segments: [TranscriptSegment] }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try encoder.encode(Wire(segments: segments))
}
