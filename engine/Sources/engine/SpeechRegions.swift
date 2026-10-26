// Finds where someone is speaking on a track, so the recogniser is only run over speech.
// Each track is mostly silent (the mic while Others talk, the system track while you talk), and Whisper invents text
// for silence; WhisperKit's own no-speech check is not implemented, so the gate has to be ours.
// The numbers below are starting points, to be tuned against real Recordings.
import Foundation

struct SpeechRegion: Equatable {
    var start: Double
    var end: Double
}

enum SpeechGate {
    static let frameSeconds = 0.1
    /// A frame is speech when its level is this many times the track's noise floor...
    static let noiseFloorMargin: Float = 4
    /// ...and at least this loud, so digital silence and faint hiss never count.
    static let minimumLevel: Float = 0.01
    /// Louder bursts shorter than this are clicks and keystrokes, not speech.
    static let minimumBurstSeconds = 0.2
    /// Context kept either side of speech, so a word is not cut at its edges.
    static let paddingSeconds = 0.3
    /// Regions closer than this are joined, so the recogniser runs over fewer, fuller windows.
    static let mergeGapSeconds = 2.0
    /// WhisperKit skips anything shorter than this, so a short region is widened to it.
    static let minimumRegionSeconds = 1.0
}

/// The regions of `samples` (mono, `sampleRate` Hz) that contain speech, in seconds, in order. Empty if there is none.
func speechRegions(in samples: [Float], sampleRate: Int = outputSampleRate) -> [SpeechRegion] {
    let frameLength = Int(SpeechGate.frameSeconds * Double(sampleRate))
    guard frameLength > 0, samples.count >= frameLength else { return [] }
    let levels = stride(from: 0, to: samples.count - frameLength + 1, by: frameLength).map { start in
        rms(samples[start..<start + frameLength])
    }

    // The noise floor is the quiet end of the track; the 10th percentile ignores the speech on top of it.
    let floor = levels.sorted()[levels.count / 10]
    let threshold = max(floor * SpeechGate.noiseFloorMargin, SpeechGate.minimumLevel)

    // Runs of frames above the threshold, as [first, last+1) frame indices.
    var bursts: [(Int, Int)] = []
    var runStart: Int?
    for (i, level) in levels.enumerated() {
        if level >= threshold {
            if runStart == nil { runStart = i }
        } else if let s = runStart {
            bursts.append((s, i))
            runStart = nil
        }
    }
    if let s = runStart { bursts.append((s, levels.count)) }

    let duration = Double(samples.count) / Double(sampleRate)
    var regions: [SpeechRegion] = []
    for (first, end) in bursts {
        let length = Double(end - first) * SpeechGate.frameSeconds
        guard length >= SpeechGate.minimumBurstSeconds else { continue }
        let padded = SpeechRegion(
            start: max(0, Double(first) * SpeechGate.frameSeconds - SpeechGate.paddingSeconds),
            end: min(duration, Double(end) * SpeechGate.frameSeconds + SpeechGate.paddingSeconds)
        )
        if let last = regions.last, padded.start - last.end < SpeechGate.mergeGapSeconds {
            regions[regions.count - 1].end = padded.end
        } else {
            regions.append(padded)
        }
    }
    return regions.map { widened($0, to: SpeechGate.minimumRegionSeconds, within: duration) }
}

private func rms(_ frame: ArraySlice<Float>) -> Float {
    var sum: Float = 0
    for x in frame { sum += x * x }
    return (sum / Float(frame.count)).squareRoot()
}

/// Grows a region symmetrically to `minimum` seconds, staying inside [0, duration].
private func widened(_ region: SpeechRegion, to minimum: Double, within duration: Double) -> SpeechRegion {
    let missing = minimum - (region.end - region.start)
    guard missing > 0 else { return region }
    var start = region.start - missing / 2
    var end = region.end + missing / 2
    if start < 0 { end = min(duration, end - start); start = 0 }
    if end > duration { start = max(0, start - (end - duration)); end = duration }
    return SpeechRegion(start: start, end: end)
}
