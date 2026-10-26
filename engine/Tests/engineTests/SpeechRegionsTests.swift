import Foundation
import Testing
@testable import engine

/// A track of `seconds` length: `level` hiss everywhere, with a tone of amplitude `amplitude` over each `bursts` range.
private func track(seconds: Double, hiss: Float = 0, bursts: [(Double, Double)] = [], amplitude: Float = 0.3) -> [Float] {
    let rate = outputSampleRate
    var samples = (0..<Int(seconds * Double(rate))).map { _ in hiss == 0 ? 0 : (Bool.random() ? hiss : -hiss) }
    for (start, end) in bursts {
        for i in Int(start * Double(rate))..<min(samples.count, Int(end * Double(rate))) {
            samples[i] = amplitude * sin(Float(i) * 0.2)
        }
    }
    return samples
}

private func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) < 0.11 }

@Suite struct SpeechRegionsTests {
    @Test func silenceHasNoSpeech() {
        #expect(speechRegions(in: track(seconds: 10)).isEmpty)
        #expect(speechRegions(in: []).isEmpty)
    }

    @Test func aBurstBecomesOneRegionPaddedOnBothSides() throws {
        let regions = speechRegions(in: track(seconds: 10, bursts: [(4, 6)]))
        let region = try #require(regions.first)
        #expect(regions.count == 1)
        #expect(close(region.start, 3.7) && close(region.end, 6.3))
    }

    @Test func burstsLessThanTheMergeGapApartAreJoined() {
        let regions = speechRegions(in: track(seconds: 20, bursts: [(2, 4), (5, 7)]))
        #expect(regions.count == 1)
        #expect(close(regions[0].start, 1.7) && close(regions[0].end, 7.3))
    }

    @Test func burstsFurtherApartStaySeparate() {
        let regions = speechRegions(in: track(seconds: 30, bursts: [(2, 4), (10, 12)]))
        #expect(regions.count == 2)
    }

    @Test func quietHissIsNotSpeechButLoudSpeechOverItIs() {
        let regions = speechRegions(in: track(seconds: 10, hiss: 0.004, bursts: [(4, 6)]))
        #expect(regions.count == 1)
        #expect(close(regions[0].start, 3.7) && close(regions[0].end, 6.3))
    }

    @Test func aClickShorterThanTheMinimumBurstIsIgnored() {
        #expect(speechRegions(in: track(seconds: 10, bursts: [(4, 4.1)])).isEmpty)
    }

    @Test func regionsStayInsideTheTrack() throws {
        let regions = speechRegions(in: track(seconds: 5, bursts: [(0, 1), (4, 5)]))
        #expect(regions.first!.start == 0)
        #expect(regions.last!.end == 5)
    }

    @Test func aShortWordIsWidenedToTheMinimumRegionLength() throws {
        let region = try #require(speechRegions(in: track(seconds: 10, bursts: [(5, 5.3)])).first)
        #expect(region.end - region.start >= SpeechGate.minimumRegionSeconds - 0.001)
        #expect(region.start <= 5 && region.end >= 5.3)
    }
}
