// Records the microphone (you) and system audio (everyone else) as two tracks.
// Microphone: AVAudioEngine. System audio: a Core Audio process tap on a private aggregate device.
// Each track is converted to 16 kHz mono as it arrives and kept with the host time of its first sample.
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

/// Converts what a capture source delivers into 16 kHz mono Int16 and appends it to a raw file.
/// Each source calls `append` from its own audio thread, so one writer must not be shared between sources.
final class TrackWriter {
    let url: URL
    private let handle: FileHandle
    private var converter: AVAudioConverter?
    private let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(outputSampleRate), channels: 1, interleaved: true)!
    private(set) var firstSampleHostSeconds: Double?
    private(set) var frames = 0
    private(set) var failure: String?

    init(url: URL) throws {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        self.url = url
        self.handle = try FileHandle(forWritingTo: url)
    }

    func append(_ buffer: AVAudioPCMBuffer, hostTime: UInt64) {
        guard failure == nil, buffer.frameLength > 0 else { return }
        if converter == nil { converter = AVAudioConverter(from: buffer.format, to: target) }
        guard let converter else { failure = "cannot convert \(buffer.format) to 16 kHz mono"; return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        if let error { failure = error.localizedDescription; return }
        guard out.frameLength > 0, let samples = out.int16ChannelData?[0] else { return }
        if firstSampleHostSeconds == nil { firstSampleHostSeconds = hostSeconds(hostTime) }
        let data = Data(bytes: samples, count: Int(out.frameLength) * 2)
        do {
            try handle.write(contentsOf: data)
            frames += Int(out.frameLength)
        } catch {
            failure = error.localizedDescription
        }
    }

    /// Closes the file and returns what was captured, or nil if nothing was.
    func finish() -> RawTrack? {
        try? handle.close()
        guard let first = firstSampleHostSeconds, frames > 0 else { return nil }
        return RawTrack(url: url, firstSampleHostSeconds: first, frames: frames)
    }
}

struct FinishedRecording {
    var micPath: String
    var systemPath: String
    var micStartHostTime: Double
    var systemStartHostTime: Double
}

final class Recorder {
    private let directory: URL
    private let mic: TrackWriter
    private let system: TrackWriter
    private let micEngine = AVAudioEngine()
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    private let ioQueue = DispatchQueue(label: "recorder.system-io")

    /// Starts both captures. Throws, with everything started so far torn down again, if either cannot start.
    init() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("meeting-recorder-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        mic = try TrackWriter(url: directory.appendingPathComponent("mic.raw"))
        system = try TrackWriter(url: directory.appendingPathComponent("system.raw"))
        do {
            try startMicrophone()
            try startSystemAudio()
        } catch {
            teardown()
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    /// Stops both captures and writes the aligned tracks.
    func finish() throws -> FinishedRecording {
        teardown()
        defer {
            for name in ["mic.raw", "system.raw"] { try? FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
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
