import AVFoundation
import Foundation
import Testing
@testable import engine

private func hostTime(seconds: Double) -> UInt64 {
    var timebase = mach_timebase_info_data_t()
    mach_timebase_info(&timebase)
    return UInt64(seconds * 1e9 * Double(timebase.denom) / Double(timebase.numer))
}

private func pieces(sampleRate: Double, seconds: Double, value: Float) -> AVAudioPCMBuffer {
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
    let frames = AVAudioFrameCount(sampleRate * seconds)
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
    buffer.frameLength = frames
    for i in 0..<Int(frames) { buffer.floatChannelData![0][i] = value }
    return buffer
}

@Suite struct MissingFramesTests {
    @Test func ignoresJitter() {
        #expect(missingFrames(expectedStart: 10.0, actualStart: 10.1) == 0)
        #expect(missingFrames(expectedStart: 10.0, actualStart: 9.9) == 0)
    }

    @Test func countsAGapInFrames() {
        #expect(missingFrames(expectedStart: 10.0, actualStart: 11.5) == 24_000)
    }
}

// The sample-rate converter may hold back a few frames, so lengths are checked to within 200 frames (12 ms).
@Suite struct CaptureRestartTests {
    let scratch: Scratch
    init() throws { scratch = try Scratch() }

    @Test func fillsTheTimeANewBufferWasMissingWithSilence() throws {
        let writer = TrackWriter(preBufferFrames: 160_000)
        try writer.startWriting(to: scratch.url("gap.raw"))
        writer.append(pieces(sampleRate: 48_000, seconds: 0.5, value: 0.5), hostTime: hostTime(seconds: 100))
        // The capture restarted: the next audio starts at 102 s, not 100.5 s.
        writer.append(pieces(sampleRate: 48_000, seconds: 0.5, value: 0.5), hostTime: hostTime(seconds: 102))

        let track = try #require(writer.finish())
        #expect(abs(track.frames - 40_000) < 200) // 0.5 s + 1.5 s of silence + 0.5 s
        let samples = stride(from: 0, to: 40_000 * 2, by: 2).map { offset in
            Int16(littleEndian: try! Data(contentsOf: track.url).subdata(in: offset..<offset + 2).withUnsafeBytes { $0.loadUnaligned(as: Int16.self) })
        }
        #expect(samples[4_000] > 0)
        #expect(samples[16_000] == 0)
        #expect(samples[39_000] > 0)
    }

    @Test func keepsConvertingAfterTheDeviceChangesSampleRate() throws {
        let writer = TrackWriter(preBufferFrames: 160_000)
        try writer.startWriting(to: scratch.url("rate.raw"))
        writer.append(pieces(sampleRate: 48_000, seconds: 0.5, value: 0.5), hostTime: hostTime(seconds: 100))
        writer.append(pieces(sampleRate: 44_100, seconds: 0.5, value: 0.5), hostTime: hostTime(seconds: 100.5))

        #expect(writer.failure == nil)
        let track = try #require(writer.finish())
        #expect(abs(track.frames - 16_000) < 400) // one second at 16 kHz, whatever the input rates were
    }
}
