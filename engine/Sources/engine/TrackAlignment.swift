// Turns two raw captured tracks into two WAV files that start at the same instant and have the same length.
// The tracks do not start together (the system track begins about 197 ms before the mic track), so they are aligned
// on the host time of each track's first sample, never on the start of the file.
import Foundation

let outputSampleRate = 16_000

/// A captured track: little-endian Int16 mono samples at `outputSampleRate`, and the host time of the first one.
struct RawTrack {
    var url: URL
    var firstSampleHostSeconds: Double
    var frames: Int
}

struct AlignedTracks {
    var frames: Int
}

enum AlignmentError: Error, CustomStringConvertible {
    case empty(String)
    var description: String {
        switch self {
        case .empty(let track): return "no audio was captured on the \(track) track"
        }
    }
}

/// Leading silence, in frames, that puts a track starting at `start` on the same timeline as one starting at `earliest`.
func leadingSilence(start: Double, earliest: Double, sampleRate: Int = outputSampleRate) -> Int {
    max(0, Int(((start - earliest) * Double(sampleRate)).rounded()))
}

/// Writes both tracks as 16 kHz mono WAV files of equal length. The later track gets leading silence; both are cut to
/// the shorter one's end.
func writeAligned(mic: RawTrack, system: RawTrack, micOut: URL, systemOut: URL) throws -> AlignedTracks {
    guard mic.frames > 0 else { throw AlignmentError.empty("microphone") }
    guard system.frames > 0 else { throw AlignmentError.empty("system audio") }
    let earliest = min(mic.firstSampleHostSeconds, system.firstSampleHostSeconds)
    let micPad = leadingSilence(start: mic.firstSampleHostSeconds, earliest: earliest)
    let systemPad = leadingSilence(start: system.firstSampleHostSeconds, earliest: earliest)
    let frames = min(micPad + mic.frames, systemPad + system.frames)
    try writeWav(mic, leadingSilence: micPad, frames: frames, to: micOut)
    try writeWav(system, leadingSilence: systemPad, frames: frames, to: systemOut)
    return AlignedTracks(frames: frames)
}

private func writeWav(_ track: RawTrack, leadingSilence: Int, frames: Int, to url: URL) throws {
    FileManager.default.createFile(atPath: url.path, contents: nil)
    let out = try FileHandle(forWritingTo: url)
    defer { try? out.close() }
    let dataBytes = frames * 2
    try out.write(contentsOf: wavHeader(dataBytes: dataBytes))

    var remaining = dataBytes
    let silentBytes = min(leadingSilence * 2, remaining)
    let chunk = 1 << 16
    var silence = silentBytes
    while silence > 0 {
        let n = min(chunk, silence)
        try out.write(contentsOf: Data(count: n))
        silence -= n
    }
    remaining -= silentBytes

    let input = try FileHandle(forReadingFrom: track.url)
    defer { try? input.close() }
    while remaining > 0, let data = try input.read(upToCount: min(chunk, remaining)), !data.isEmpty {
        try out.write(contentsOf: data)
        remaining -= data.count
    }
    if remaining > 0 { try out.write(contentsOf: Data(count: remaining)) }
}

func wavHeader(dataBytes: Int, sampleRate: Int = outputSampleRate) -> Data {
    func u32(_ v: Int) -> [UInt8] { (0..<4).map { UInt8((v >> (8 * $0)) & 0xff) } }
    func u16(_ v: Int) -> [UInt8] { (0..<2).map { UInt8((v >> (8 * $0)) & 0xff) } }
    var h = Data()
    h += Data("RIFF".utf8) + u32(36 + dataBytes) + Data("WAVE".utf8)
    h += Data("fmt ".utf8) + u32(16) + u16(1) + u16(1) + u32(sampleRate) + u32(sampleRate * 2) + u16(2) + u16(16)
    h += Data("data".utf8) + u32(dataBytes)
    return h
}
