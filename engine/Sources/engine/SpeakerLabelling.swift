// Gives each voice on the system track a stable label: Speaker 1, Speaker 2, and so on.
// Pure functions on plain values, so it is tested without a model or any audio.
import Foundation

/// One stretch of the system track in which the diarizer heard a single voice.
struct SpeakerTurn: Equatable {
    var start: Double
    var end: Double
    /// The diarizer's own id for the voice. Only meaningful within one Recording.
    var speaker: Int
}

/// One speaker label per segment, in the segments' order. The diarizer's ids are renumbered by the order in which each
/// voice is first heard, so "Speaker 1" is whoever spoke first and the labels never depend on the diarizer's numbering.
/// A segment goes to the voice that speaks longest within it; one that overlaps no turn goes to the nearest turn.
/// With no turns at all (nothing diarized) every segment is Speaker 1.
func assignSpeakers(to segments: [TranscriptSegment], turns: [SpeakerTurn]) -> [String] {
    let voices = segments.map { voice(for: $0, in: turns) }
    var numbers: [Int: Int] = [:]
    // Numbered in start order, whatever order the segments arrive in; ties keep their given order.
    for i in segments.indices.sorted(by: { (segments[$0].start, $0) < (segments[$1].start, $1) }) where numbers[voices[i]] == nil {
        numbers[voices[i]] = numbers.count + 1
    }
    return voices.map { "Speaker \(numbers[$0]!)" }
}

/// Used when there is no turn to take an id from.
private let unknownVoice = -1

private func voice(for segment: TranscriptSegment, in turns: [SpeakerTurn]) -> Int {
    var spoken: [Int: Double] = [:]
    for turn in turns {
        let overlap = min(segment.end, turn.end) - max(segment.start, turn.start)
        if overlap > 0 { spoken[turn.speaker, default: 0] += overlap }
    }
    // Ties go to the lower id so the answer never depends on dictionary order.
    if let best = spoken.max(by: { ($0.value, $1.key) < ($1.value, $0.key) }) { return best.key }
    let nearest = turns.min { (gap($0, segment), $0.speaker) < (gap($1, segment), $1.speaker) }
    return nearest?.speaker ?? unknownVoice
}

/// How far a turn is from a segment, in seconds; zero if they touch.
private func gap(_ turn: SpeakerTurn, _ segment: TranscriptSegment) -> Double {
    max(0, max(turn.start - segment.end, segment.start - turn.end))
}
