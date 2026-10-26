import AVFoundation
import Foundation
import Testing
@testable import engine

private func chunk(_ value: Int16, frames: Int) -> Data {
    var data = Data()
    for _ in 0..<frames { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
    return data
}

private func int16s(_ data: Data) -> [Int16] {
    stride(from: 0, to: data.count, by: 2).map {
        Int16(littleEndian: data.subdata(in: $0..<$0 + 2).withUnsafeBytes { $0.loadUnaligned(as: Int16.self) })
    }
}

@Suite struct PCMBufferTests {
    @Test func holdsEverythingWhileUnderCapacity() {
        var buffer = PCMBuffer(capacityFrames: 1000)
        buffer.append(chunk(1, frames: 400))
        buffer.append(chunk(2, frames: 400))
        #expect(buffer.frames == 800)
        #expect(buffer.droppedFrames == 0)
        #expect(buffer.drain().map { int16s($0).first } == [1, 2])
    }

    @Test func dropsTheOldestAudioOnceFull() {
        var buffer = PCMBuffer(capacityFrames: 1000)
        for value in 1...5 { buffer.append(chunk(Int16(value), frames: 400)) }
        // 2000 frames arrived; whole chunks go while the rest still fills the capacity, so the last three stay.
        #expect(buffer.frames == 1200)
        #expect(buffer.droppedFrames == 800)
        #expect(buffer.drain().map { int16s($0).first } == [3, 4, 5])
    }

    @Test func neverHoldsLessThanTheCapacityOnceFull() {
        var buffer = PCMBuffer(capacityFrames: 1000)
        for _ in 0..<50 {
            buffer.append(chunk(1, frames: 333))
            #expect(buffer.frames + buffer.droppedFrames > 0)
        }
        #expect(buffer.frames >= 1000)
        #expect(buffer.frames < 1000 + 333)
    }

    @Test func isEmptyAfterDrainingButRemembersWhatWasDropped() {
        var buffer = PCMBuffer(capacityFrames: 100)
        for _ in 0..<4 { buffer.append(chunk(1, frames: 100)) }
        _ = buffer.drain()
        #expect(buffer.frames == 0)
        #expect(buffer.droppedFrames == 300)
        #expect(buffer.drain().isEmpty)
    }
}

/// Half a second of constant 48 kHz mono float audio, as the microphone delivers it.
private func halfSecond(_ value: Float) -> AVAudioPCMBuffer {
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 24_000)!
    buffer.frameLength = 24_000
    for i in 0..<24_000 { buffer.floatChannelData![0][i] = value }
    return buffer
}

// The sample-rate converter may hold back a few frames, so lengths are checked to within 200 frames (12 ms).
@Suite struct PreBufferedTrackTests {
    let scratch: Scratch
    init() throws { scratch = try Scratch() }

    @Test func writesNothingToDiskWhileOnlyHoldingAudio() throws {
        let writer = TrackWriter(preBufferFrames: 160_000)
        writer.append(halfSecond(0.5), hostTime: 1_000_000_000)
        #expect(try FileManager.default.contentsOfDirectory(atPath: scratch.dir.path).isEmpty)
        #expect(writer.finish() == nil) // never started writing, so there is no track
    }

    @Test func keepsTheHeldAudioAheadOfWhatFollowsOnceWritingStarts() throws {
        let writer = TrackWriter(preBufferFrames: 160_000)
        writer.append(halfSecond(0.5), hostTime: 1_000_000_000)
        writer.append(halfSecond(0.5), hostTime: 1_000_000_000)
        try writer.startWriting(to: scratch.url("late.raw"))
        writer.append(halfSecond(-0.5), hostTime: 1_000_000_000)

        let track = try #require(writer.finish())
        let samples = int16s(try Data(contentsOf: track.url))
        #expect(samples.count == track.frames)
        #expect(abs(track.frames - 24_000) < 200)
        #expect(samples[100] > 0 && samples[15_000] > 0) // held before the click
        #expect(samples[17_000] < 0 && samples[track.frames - 100] < 0) // written after it
    }

    @Test func movesTheFirstSampleTimeForwardByWhatWasDropped() throws {
        // Room for one second; three seconds arrive in half-second pieces, so the oldest pieces fall off the front.
        let writer = TrackWriter(preBufferFrames: 16_000)
        let start = hostSeconds(1_000_000_000)
        for _ in 0..<6 { writer.append(halfSecond(0.5), hostTime: 1_000_000_000) }
        try writer.startWriting(to: scratch.url("late.raw"))

        let track = try #require(writer.finish())
        #expect(track.frames >= 16_000 - 200)
        #expect(track.frames < 16_000 + 8_000 + 200) // at most one extra piece is kept
        // Whatever was dropped, the held audio still ends where the captured audio ended: three seconds in.
        let end = track.firstSampleHostSeconds + Double(track.frames) / 16_000
        #expect(abs(end - (start + 3.0)) < 0.02)
    }
}
