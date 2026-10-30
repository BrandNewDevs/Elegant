// The most recent audio of one track, held in memory only. From Detection until the Prompt is answered the engine
// captures into one of these; accepting flushes it to the start of the Recording, closing the Prompt throws it away.
// It never grows past `capacityFrames`, so a Prompt left up for hours holds the same last few minutes.
// Nothing here touches the disk.
import Foundation

/// How much audio is held before a Recording starts: the last few minutes of each track.
let preBufferSeconds = 300

/// Little-endian Int16 mono samples at `outputSampleRate`, oldest dropped first once `capacityFrames` is exceeded.
struct PCMBuffer {
    let capacityFrames: Int
    /// Frames currently held.
    private(set) var frames = 0
    /// Frames discarded off the front so far; the held audio starts this many frames after the first one captured.
    private(set) var droppedFrames = 0
    private var chunks: [Data] = []

    init(capacityFrames: Int) {
        self.capacityFrames = capacityFrames
    }

    mutating func append(_ chunk: Data) {
        chunks.append(chunk)
        frames += chunk.count / 2
        // Whole chunks only, and only while what is left still fills the capacity.
        while let oldest = chunks.first, frames - oldest.count / 2 >= capacityFrames {
            chunks.removeFirst()
            frames -= oldest.count / 2
            droppedFrames += oldest.count / 2
        }
    }

    /// Hands over everything held, oldest first, and leaves the buffer empty. `droppedFrames` is kept.
    mutating func drain() -> [Data] {
        defer { chunks = []; frames = 0 }
        return chunks
    }
}
