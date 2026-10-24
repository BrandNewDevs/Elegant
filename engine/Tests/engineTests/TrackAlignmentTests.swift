import Foundation
import Testing
@testable import engine

/// A scratch directory per test, removed afterwards.
final class Scratch {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("engine-tests-\(UUID().uuidString)")
    init() throws { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    deinit { try? FileManager.default.removeItem(at: dir) }

    func url(_ name: String) -> URL { dir.appendingPathComponent(name) }

    /// A raw track whose samples all equal `value`.
    func raw(_ name: String, value: Int16, frames: Int, firstSample: Double) throws -> RawTrack {
        var data = Data()
        for _ in 0..<frames { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        try data.write(to: url(name))
        return RawTrack(url: url(name), firstSampleHostSeconds: firstSample, frames: frames)
    }

    func samples(_ url: URL) throws -> [Int16] {
        let data = try Data(contentsOf: url)
        return stride(from: 44, to: data.count, by: 2).map {
            Int16(littleEndian: data.subdata(in: $0..<$0 + 2).withUnsafeBytes { $0.loadUnaligned(as: Int16.self) })
        }
    }
}

@Suite struct TrackAlignmentTests {
    let scratch: Scratch
    init() throws { scratch = try Scratch() }

    @Test func laterTrackGetsLeadingSilenceEqualToTheHostTimeGap() throws {
        // The system track starts 197 ms before the mic track, as in the prototype.
        let system = try scratch.raw("sys.raw", value: 7, frames: 32_000, firstSample: 1000.0)
        let mic = try scratch.raw("mic.raw", value: 3, frames: 32_000, firstSample: 1000.197)
        let micOut = scratch.url("mic.wav"), systemOut = scratch.url("system.wav")

        _ = try writeAligned(mic: mic, system: system, micOut: micOut, systemOut: systemOut)

        let silence = Int((0.197 * 16_000).rounded())
        let m = try scratch.samples(micOut)
        #expect(m.prefix(silence).allSatisfy { $0 == 0 })
        #expect(m[silence] == 3)
        #expect(try scratch.samples(systemOut)[0] == 7)
    }

    @Test func bothFilesHaveTheSameLengthAndAreCutToTheShorterEnd() throws {
        let system = try scratch.raw("sys.raw", value: 7, frames: 40_000, firstSample: 1000.0)
        let mic = try scratch.raw("mic.raw", value: 3, frames: 20_000, firstSample: 1000.5)
        let micOut = scratch.url("mic.wav"), systemOut = scratch.url("system.wav")

        let aligned = try writeAligned(mic: mic, system: system, micOut: micOut, systemOut: systemOut)

        #expect(aligned.frames == 8_000 + 20_000)
        #expect(try scratch.samples(micOut).count == aligned.frames)
        #expect(try scratch.samples(systemOut).count == aligned.frames)
    }

    @Test func outputIsA16kHzMonoWav() throws {
        let t = try scratch.raw("a.raw", value: 1, frames: 1_000, firstSample: 5)
        let micOut = scratch.url("mic.wav")
        _ = try writeAligned(mic: t, system: t, micOut: micOut, systemOut: scratch.url("system.wav"))

        let h = try Data(contentsOf: micOut).prefix(44)
        func u32(_ at: Int) -> Int { Int(h[at]) | Int(h[at + 1]) << 8 | Int(h[at + 2]) << 16 | Int(h[at + 3]) << 24 }
        #expect(String(decoding: h.prefix(4), as: UTF8.self) == "RIFF")
        #expect(String(decoding: h[8..<12], as: UTF8.self) == "WAVE")
        #expect(h[22] == 1) // mono
        #expect(u32(24) == 16_000)
        #expect(u32(40) == 2_000) // data bytes
    }

    @Test func aTrackWithNoAudioIsAnError() throws {
        let some = try scratch.raw("a.raw", value: 1, frames: 100, firstSample: 5)
        let none = RawTrack(url: some.url, firstSampleHostSeconds: 0, frames: 0)
        #expect(throws: AlignmentError.self) {
            try writeAligned(mic: none, system: some, micOut: scratch.url("m.wav"), systemOut: scratch.url("s.wav"))
        }
    }
}
