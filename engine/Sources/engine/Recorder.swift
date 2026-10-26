// Records the microphone (you) and system audio (everyone else) as two tracks.
// Microphone: AVAudioEngine. System audio: a Core Audio process tap on a private aggregate device.
// Each track is converted to 16 kHz mono as it arrives and kept with the host time of its first sample.
// From Detection the audio is only held in memory (see PCMBuffer.swift); accepting the Prompt starts writing it to disk.
// On stop the two are aligned on that host time and written out; see TrackAlignment.swift.
import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

func hostSeconds(_ hostTime: UInt64) -> Double {
    var timebase = mach_timebase_info_data_t()
    mach_timebase_info(&timebase)
    return Double(hostTime) * Double(timebase.numer) / Double(timebase.denom) / 1e9
}

struct RecordingError: Error, CustomStringConvertible {
    var description: String
}

/// Converts what a capture source delivers into 16 kHz mono Int16. Until `startWriting` the audio is held in memory
/// (the last `preBufferSeconds`) and nothing exists on disk; after it, the held audio is flushed to a raw file and the
/// rest follows. Each source calls `append` from its own audio thread, so one writer must not be shared between sources.
final class TrackWriter {
    private let lock = NSLock()
    private var buffer: PCMBuffer
    private var handle: FileHandle?
    private var url: URL?
    private var converter: AVAudioConverter?
    private let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(outputSampleRate), channels: 1, interleaved: true)!
    private var firstBufferHostSeconds: Double?
    private var frames = 0
    private var _failure: String?

    init(preBufferFrames: Int) {
        buffer = PCMBuffer(capacityFrames: preBufferFrames)
    }

    var failure: String? {
        lock.lock(); defer { lock.unlock() }
        return _failure
    }

    /// Host time of the first sample still held or written. Audio dropped off the front of the buffer moves it later.
    var firstSampleHostSeconds: Double? {
        lock.lock(); defer { lock.unlock() }
        return firstSample
    }

    private var firstSample: Double? {
        firstBufferHostSeconds.map { $0 + Double(buffer.droppedFrames) / Double(outputSampleRate) }
    }

    func append(_ pcm: AVAudioPCMBuffer, hostTime: UInt64) {
        lock.lock(); defer { lock.unlock() }
        guard _failure == nil, pcm.frameLength > 0 else { return }
        // Taken from the first buffer received, not the first one converted: the sample-rate converter can hold back its
        // first output, and that must not push the track's start time later.
        if firstBufferHostSeconds == nil { firstBufferHostSeconds = hostSeconds(hostTime) }
        if converter == nil { converter = AVAudioConverter(from: pcm.format, to: target) }
        guard let converter else { _failure = "cannot convert \(pcm.format) to 16 kHz mono"; return }
        let capacity = AVAudioFrameCount(Double(pcm.frameLength) * target.sampleRate / pcm.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return pcm
        }
        if let error { _failure = error.localizedDescription; return }
        guard out.frameLength > 0, let samples = out.int16ChannelData?[0] else { return }
        let data = Data(bytes: samples, count: Int(out.frameLength) * 2)
        guard let handle else {
            buffer.append(data)
            return
        }
        do {
            try handle.write(contentsOf: data)
            frames += Int(out.frameLength)
        } catch {
            _failure = error.localizedDescription
        }
    }

    /// Writes what is held to a new file at `url`, and every later buffer after it.
    func startWriting(to url: URL) throws {
        lock.lock(); defer { lock.unlock() }
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        frames = buffer.frames
        for chunk in buffer.drain() { try handle.write(contentsOf: chunk) }
        self.url = url
        self.handle = handle
    }

    /// Closes the file and returns what was captured, or nil if nothing was.
    func finish() -> RawTrack? {
        lock.lock(); defer { lock.unlock() }
        try? handle?.close()
        guard let url, let first = firstSample, frames > 0 else { return nil }
        return RawTrack(url: url, firstSampleHostSeconds: first, frames: frames)
    }
}

struct FinishedRecording {
    var micPath: String
    var systemPath: String
    var micStartHostTime: Double
    var systemStartHostTime: Double
}

/// Captures both tracks. It starts out only holding the last `preBufferSeconds` in memory (Detection); `beginRecording`
/// turns that into a Recording on disk, and `discard` throws it away. Nothing is written before `beginRecording`.
final class Recorder {
    private var directory: URL?
    private let mic: TrackWriter
    private let system: TrackWriter
    private let micEngine = AVAudioEngine()
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    private let ioQueue = DispatchQueue(label: "recorder.system-io")

    /// Whether `beginRecording` has been called. Only touched from the command-reading thread.
    private(set) var isRecording = false

    /// Starts both captures into memory. Throws, with everything started so far torn down again, if either cannot start.
    init(preBufferSeconds: Int = preBufferSeconds) throws {
        mic = TrackWriter(preBufferFrames: preBufferSeconds * outputSampleRate)
        system = TrackWriter(preBufferFrames: preBufferSeconds * outputSampleRate)
        do {
            try startMicrophone()
            try startSystemAudio()
        } catch {
            teardown()
            throw error
        }
    }

    /// Keeps what was captured so far and writes it, and everything from now on, to files. On failure the captures are
    /// stopped and nothing is left on disk.
    func beginRecording() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("meeting-recorder-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try mic.startWriting(to: directory.appendingPathComponent("mic.raw"))
            try system.startWriting(to: directory.appendingPathComponent("system.raw"))
        } catch {
            teardown()
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
        self.directory = directory
        isRecording = true
    }

    /// Stops both captures and drops what was held. Only for a Recorder that has not begun recording.
    func discard() {
        teardown()
    }

    /// Stops both captures and writes the aligned tracks.
    func finish() throws -> FinishedRecording {
        guard let directory else { throw RecordingError(description: "no recording is in progress") }
        teardown()
        var wrote = false
        defer {
            for name in ["mic.raw", "system.raw"] { try? FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
            // A failed Recording leaves nothing behind.
            if !wrote { try? FileManager.default.removeItem(at: directory) }
        }
        let micTrack = mic.finish()
        let systemTrack = system.finish()
        if let f = mic.failure { throw RecordingError(description: "microphone: \(f)") }
        if let f = system.failure { throw RecordingError(description: "system audio: \(f)") }
        guard let micTrack else { throw AlignmentError.empty("microphone") }
        guard let systemTrack else { throw AlignmentError.empty("system audio") }
        let micOut = directory.appendingPathComponent("mic.wav")
        let systemOut = directory.appendingPathComponent("system.wav")
        _ = try writeAligned(mic: micTrack, system: systemTrack, micOut: micOut, systemOut: systemOut)
        wrote = true
        return FinishedRecording(
            micPath: micOut.path,
            systemPath: systemOut.path,
            micStartHostTime: micTrack.firstSampleHostSeconds,
            systemStartHostTime: systemTrack.firstSampleHostSeconds
        )
    }

    private func startMicrophone() throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            let answered = DispatchSemaphore(value: 0)
            var granted = false
            AVCaptureDevice.requestAccess(for: .audio) { granted = $0; answered.signal() }
            _ = answered.wait(timeout: .now() + 60)
            if !granted { throw RecordingError(description: "microphone access was not granted") }
        default:
            throw RecordingError(description: "microphone access is denied; allow it in System Settings > Privacy & Security")
        }
        let format = micEngine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { throw RecordingError(description: "there is no microphone input") }
        micEngine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { [mic] buffer, when in
            mic.append(buffer, hostTime: when.hostTime)
        }
        try micEngine.start()
    }

    private func startSystemAudio() throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.name = "meeting-recorder-tap"
        description.muteBehavior = .unmuted
        var status = AudioHardwareCreateProcessTap(description, &tapID)
        guard status == noErr else { throw RecordingError(description: "cannot tap system audio (status \(status)); allow system audio recording in System Settings > Privacy & Security") }

        var formatAddress = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        status = AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &size, &asbd)
        guard status == noErr, let format = AVAudioFormat(streamDescription: &asbd) else {
            throw RecordingError(description: "cannot read the system audio format (status \(status))")
        }

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "meeting-recorder-aggregate",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]],
        ]
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        guard status == noErr else { throw RecordingError(description: "cannot create the system audio device (status \(status))") }

        status = AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregateID, ioQueue) { [system] _, input, inputTime, _, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input) else { return }
            system.append(buffer, hostTime: inputTime.pointee.mHostTime)
        }
        guard status == noErr else { throw RecordingError(description: "cannot read system audio (status \(status))") }
        status = AudioDeviceStart(aggregateID, ioProc)
        guard status == noErr else { throw RecordingError(description: "cannot start system audio (status \(status))") }
    }

    /// Stops the captures; safe to call more than once and after a partial start.
    private func teardown() {
        if micEngine.isRunning { micEngine.stop() }
        micEngine.inputNode.removeTap(onBus: 0)
        if let proc = ioProc {
            AudioDeviceStop(aggregateID, proc)
            AudioDeviceDestroyIOProcID(aggregateID, proc)
            ioProc = nil
        }
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        // Wait for any callback still running on the IO queue.
        ioQueue.sync {}
    }
}
