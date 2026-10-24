import Foundation
import Testing
@testable import engine

private func seg(_ start: Double, _ end: Double, _ text: String, ratio: Double = 1) -> RecognisedSegment {
    RecognisedSegment(start: start, end: end, text: text, compressionRatio: ratio)
}

@Suite struct TranscriptMergeTests {
    @Test func micWordsAreYouAndSystemWordsAreOthers() {
        let merged = mergeTracks(mic: [seg(0, 2, "Hello")], system: [seg(3, 5, "Hi there")])
        #expect(merged.map(\.speaker) == ["You", "Others"])
    }

    @Test func segmentsAreOrderedByStartAcrossBothTracks() {
        let merged = mergeTracks(
            mic: [seg(10, 12, "c"), seg(1, 2, "a")],
            system: [seg(5, 6, "b"), seg(20, 21, "d")]
        )
        #expect(merged.map(\.text) == ["a", "b", "c", "d"])
    }

    @Test func overlappingSpeechIsKept() {
        let merged = mergeTracks(mic: [seg(4, 8, "go on")], system: [seg(5, 7, "yes")])
        #expect(merged.count == 2)
        #expect(merged.map(\.start) == [4, 5])
    }

    @Test func tiesOnStartAndEndPutYouFirst() {
        let merged = mergeTracks(mic: [seg(1, 2, "mine")], system: [seg(1, 2, "theirs")])
        #expect(merged.map(\.speaker) == ["You", "Others"])
        let swapped = mergeTracks(mic: [seg(1, 2, "mine")], system: [seg(1, 1.5, "theirs")])
        #expect(swapped.map(\.speaker) == ["Others", "You"])
    }

    @Test func textIsTrimmedAndEmptySegmentsAreDropped() {
        let merged = mergeTracks(mic: [seg(0, 1, "  hello \n"), seg(1, 2, "   "), seg(2, 3, "")], system: [])
        #expect(merged.map(\.text) == ["hello"])
    }

    @Test func wholeSegmentSoundTagsAreDroppedButBracketsInSpeechAreKept() {
        let merged = mergeTracks(
            mic: [seg(0, 1, "[BLANK_AUDIO]"), seg(1, 2, " (music) "), seg(2, 3, "see item (b) below"), seg(3, 4, "[a] and [b]")],
            system: []
        )
        #expect(merged.map(\.text) == ["see item (b) below", "[a] and [b]"])
    }

    @Test func repetitionLoopsAreDropped() {
        let merged = mergeTracks(mic: [seg(0, 5, "you you you you", ratio: 3.1), seg(5, 6, "fine", ratio: 2.4)], system: [])
        #expect(merged.map(\.text) == ["fine"])
    }

    @Test func timesAreRoundedToTwoDecimals() {
        let merged = mergeTracks(mic: [seg(1.23456, 2.5049, "x")], system: [])
        #expect(merged[0].start == 1.23)
        #expect(merged[0].end == 2.5)
    }

    @Test func aTrackWithNoSpeechContributesNothingAndBothEmptyIsAnEmptyTranscript() {
        #expect(mergeTracks(mic: [], system: [seg(0, 1, "hi")]).map(\.speaker) == ["Others"])
        #expect(mergeTracks(mic: [], system: []).isEmpty)
    }

    @Test func transcriptJSONHasTheDocumentedShape() throws {
        let data = try encodeTranscript(mergeTracks(mic: [seg(12.3, 15.8, "Hello")], system: []))
        #expect(String(decoding: data, as: UTF8.self) == #"{"segments":[{"end":15.8,"speaker":"You","start":12.3,"text":"Hello"}]}"#)
    }
}
