import Foundation
import Testing
@testable import engine

private func seg(_ start: Double, _ end: Double) -> TranscriptSegment {
    TranscriptSegment(start: start, end: end, speaker: "", text: "x")
}

private func turn(_ start: Double, _ end: Double, _ speaker: Int) -> SpeakerTurn {
    SpeakerTurn(start: start, end: end, speaker: speaker)
}

@Suite struct SpeakerLabellingTests {
    @Test func voicesAreNumberedByWhenTheyAreFirstHeardNotByTheDiarizersIds() {
        let labels = assignSpeakers(
            to: [seg(0, 2), seg(3, 5), seg(6, 8)],
            turns: [turn(0, 2, 7), turn(3, 5, 2), turn(6, 8, 7)]
        )
        #expect(labels == ["Speaker 1", "Speaker 2", "Speaker 1"])
    }

    @Test func numberingFollowsStartTimeWhateverTheOrderOfTheSegments() {
        let labels = assignSpeakers(to: [seg(6, 8), seg(0, 2)], turns: [turn(0, 2, 0), turn(6, 8, 1)])
        #expect(labels == ["Speaker 2", "Speaker 1"])
    }

    @Test func aSegmentGoesToTheVoiceThatSpeaksLongestWithinIt() {
        let labels = assignSpeakers(to: [seg(0, 10)], turns: [turn(0, 3, 0), turn(3, 10, 1), turn(20, 30, 2)])
        #expect(labels == ["Speaker 1"])
        // Speaker 1 here is the voice with the longest overlap, whatever its diarizer id.
        let second = assignSpeakers(to: [seg(0, 1), seg(0, 10)], turns: [turn(0, 1, 5), turn(0, 3, 0), turn(3, 10, 1)])
        #expect(second == ["Speaker 1", "Speaker 2"])
    }

    @Test func aSegmentThatOverlapsNoTurnGoesToTheNearestOne() {
        let labels = assignSpeakers(to: [seg(0, 2), seg(12, 13)], turns: [turn(0, 2, 0), turn(5, 6, 1), turn(20, 21, 2)])
        // 12-13 is 6 s from the turn ending at 6 and 7 s from the one starting at 20.
        #expect(labels == ["Speaker 1", "Speaker 2"])
    }

    @Test func withNoTurnsEverySegmentIsSpeakerOne() {
        #expect(assignSpeakers(to: [seg(0, 1), seg(2, 3)], turns: []) == ["Speaker 1", "Speaker 1"])
        #expect(assignSpeakers(to: [], turns: [turn(0, 1, 0)]).isEmpty)
    }

    @Test func equalOverlapGoesToTheLowerId() {
        let labels = assignSpeakers(to: [seg(0, 4)], turns: [turn(2, 4, 3), turn(0, 2, 1)])
        #expect(labels == ["Speaker 1"])
        #expect(assignSpeakers(to: [seg(0, 4), seg(4, 5)], turns: [turn(2, 4, 3), turn(0, 2, 1), turn(4, 5, 3)]) == ["Speaker 1", "Speaker 2"])
    }
}

@Suite struct DiarizedMergeTests {
    private func rec(_ start: Double, _ end: Double, _ text: String, ratio: Double = 1) -> RecognisedSegment {
        RecognisedSegment(start: start, end: end, text: text, compressionRatio: ratio)
    }

    @Test func systemVoicesAreLabelledAndYouIsStillTheMic() {
        let merged = mergeTracks(
            mic: [rec(2, 3, "me")],
            system: [rec(0, 1, "a"), rec(4, 5, "b")],
            turns: [turn(0, 1, 4), turn(4, 5, 9)]
        )
        #expect(merged.map(\.speaker) == ["Speaker 1", "You", "Speaker 2"])
    }

    @Test func aDroppedSegmentDoesNotTakeASpeakerNumber() {
        let merged = mergeTracks(
            mic: [],
            system: [rec(0, 1, "you you you", ratio: 3), rec(2, 3, "real")],
            turns: [turn(0, 1, 0), turn(2, 3, 1)]
        )
        #expect(merged.map(\.speaker) == ["Speaker 1"])
    }
}
