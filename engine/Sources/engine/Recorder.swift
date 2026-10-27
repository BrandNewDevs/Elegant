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

/// A gap shorter than this is clock jitter, not lost audio.
let gapThresholdSeconds = 0.25

/// Frames of silence to insert when a buffer starts at `actualStart` but the audio so far ends at `expectedStart`.
func missingFrames(expectedStart: Double, actualStart: Double, sampleRate: Int = outputSampleRate) -> Int {
    let gap = actualStart - expectedStart
    return gap > gapThresholdSeconds ? Int((gap * Double(sampleRate)).rounded()) : 0
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
    private var converterSource: AVAudioFormat?
    private let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(outputSampleRate), channels: 1, interleaved: true)!
    private var firstBufferHostSeconds: Double?
    private var frames = 0
    /// Every frame appended so far, held, written or dropped, silence included. `frames` only counts the written ones.
    private var appendedFrames = 0
    private var lastAppendUptime = DispatchTime.now().uptimeNanoseconds
    private var _failure: String?

    init(preBufferFrames: Int) {
        buffer = PCMBuffer(capacityFrames: preBufferFrames)
    }

    var failure: String? {
        lock.lock(); defer { lock.unlock() }
        return _failure
    }

    /// How long since a buffer last arrived, or since this writer was made if none has.
    var secondsSinceLastBuffer: Double {
        lock.lock(); defer { lock.unlock() }
        return Double(DispatchTime.now().uptimeNanoseconds - lastAppendUptime) / 1e9
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
        lastAppendUptime = DispatchTime.now().uptimeNanoseconds
        // Taken from the first buffer received, not the first one converted: the sample-rate converter can hold back its
        // first output, and that must not push the track's start time later.
        if firstBufferHostSeconds == nil { firstBufferHostSeconds = hostSeconds(hostTime) }
        // The device can change format mid-Recording (a call app switching the sample rate); the old converter is wrong then.
        if converter == nil || converterSource != pcm.format {
            converter = AVAudioConverter(from: pcm.format, to: target)
            converterSource = pcm.format
        }
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
        var data = Data(bytes: samples, count: Int(out.frameLength) * 2)
        // Audio missing since the last buffer (a capture restart) becomes silence, so this track stays on the shared timeline.
        let missing = missingFrames(expectedStart: firstBufferHostSeconds! + Double(appendedFrames) / Double(outputSampleRate), actualStart: hostSeconds(hostTime))
        if missing > 0 { data = Data(count: missing * 2) + data }
        appendedFrames += Int(out.frameLength) + missing
        guard let handle else {
            buffer.append(data)
            return
        }
        do {
            try handle.write(contentsOf: data)
            frames += data.count / 2
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
    /// Restarts and the watchdog run here, one at a time. `captureLock` keeps them from racing `teardown`.
    private let supervisorQueue = DispatchQueue(label: "recorder.supervisor")
    private let captureLock = NSLock()
    private var tornDown = false
    private var configObserver: NSObjectProtocol?
    private var watchdog: DispatchSourceTimer?

    /// Uptime of the last restart of each source, so the watchdog gives a restart time to take. Supervisor queue only.
    private var lastMicRestart: UInt64 = 0
    private var lastSystemRestart: UInt64 = 0

    /// Told about trouble the Recorder cannot work around, so the app can show it. Set before the first capture.
    var onProblem: (String) -> Void = { _ in }

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
        // The engine stops itself when the input device changes (a call app taking the microphone, headphones plugged in).
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: micEngine, queue: nil) { [weak self] _ in
            self?.supervisorQueue.async { self?.restartMicrophone(reason: "the input device changed") }
        }
        startWatchdog()
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
        try startMicrophoneEngine()
    }

    /// Taps the current input device and starts the engine. Used at the start and again after every restart.
    private func startMicrophoneEngine() throws {
        let format = micEngine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { throw RecordingError(description: "there is no microphone input") }
        micEngine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { [mic] buffer, when in
            mic.append(buffer, hostTime: when.hostTime)
        }
        try micEngine.start()
    }

    /// A restart that worked: worth a line in the log, not a notification.
    private func note(_ message: String) {
        FileHandle.standardError.write(Data("[recorder] \(message)\n".utf8))
    }

    /// Brings the microphone back after the engine stopped. Retries for a few seconds, because the new device is often
    /// not ready at once. Whatever was missed in between becomes silence in the track (see `TrackWriter.append`).
    private func restartMicrophone(reason: String) {
        lastMicRestart = DispatchTime.now().uptimeNanoseconds
        for attempt in 1...6 {
            captureLock.lock()
            if tornDown { captureLock.unlock(); return }
            micEngine.stop()
            micEngine.inputNode.removeTap(onBus: 0)
            do {
                try startMicrophoneEngine()
                captureLock.unlock()
                note("the microphone was restarted because \(reason)")
                return
            } catch {
                captureLock.unlock()
                if attempt == 6 { onProblem("the microphone could not be restarted (\(error)); its track will be silent until it is") }
            }
            Thread.sleep(forTimeInterval: 0.5 * Double(attempt))
        }
    }

    /// Brings the system audio tap back by rebuilding it from nothing.
    private func restartSystemAudio(reason: String) {
        lastSystemRestart = DispatchTime.now().uptimeNanoseconds
        captureLock.lock(); defer { captureLock.unlock() }
        if tornDown { return }
        stopSystemAudio()
        do {
            try startSystemAudio()
            note("system audio was restarted because \(reason)")
        } catch {
            onProblem("system audio could not be restarted (\(error)); its track will be silent until it is")
        }
    }

    /// Every couple of seconds: a source that has delivered nothing for a while is restarted, notification or not.
    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: supervisorQueue)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let now = DispatchTime.now().uptimeNanoseconds
            if self.mic.secondsSinceLastBuffer > 3, now - self.lastMicRestart > 10_000_000_000 {
                self.restartMicrophone(reason: "it stopped delivering audio")
            }
            if self.system.secondsSinceLastBuffer > 3, now - self.lastSystemRestart > 10_000_000_000 {
                self.restartSystemAudio(reason: "it stopped delivering audio")
            }
        }
        timer.resume()
        watchdog = timer
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
        captureLock.lock()
        tornDown = true
        captureLock.unlock()
        watchdog?.cancel()
        watchdog = nil
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        // Let a restart that is already running finish before the engine is taken apart under it.
        supervisorQueue.sync {}
        captureLock.lock(); defer { captureLock.unlock() }
        if micEngine.isRunning { micEngine.stop() }
        micEngine.inputNode.removeTap(onBus: 0)
        stopSystemAudio()
    }

    private func stopSystemAudio() {
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
