// The macOS permissions first-run setup asks for before the first Recording needs them.
import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

/// Whether the microphone is allowed right now. Never shows a prompt, so it is safe to run at every launch.
func microphoneAccessGranted() -> Bool {
    AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
}

/// Shows the microphone prompt if the user has not answered it yet, and reports whether access is granted.
func requestMicrophoneAccess() async -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return true
    case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
    default: return false
    }
}

/// macOS has no call that asks for system audio access or reports it, so this starts a system audio tap for a moment,
/// which is what shows the prompt, and counts the access as granted if the tap runs.
func requestSystemAudioAccess() -> Bool {
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    description.uuid = UUID()
    description.name = "meeting-recorder-permission-check"
    description.muteBehavior = .unmuted
    var tapID = AudioObjectID(kAudioObjectUnknown)
    guard AudioHardwareCreateProcessTap(description, &tapID) == noErr else { return false }
    defer { AudioHardwareDestroyProcessTap(tapID) }

    var aggregateID = AudioObjectID(kAudioObjectUnknown)
    let aggregate: [String: Any] = [
        kAudioAggregateDeviceNameKey: "meeting-recorder-permission-check",
        kAudioAggregateDeviceUIDKey: UUID().uuidString,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceIsStackedKey: false,
        kAudioAggregateDeviceTapAutoStartKey: true,
        kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]],
    ]
    guard AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID) == noErr else { return false }
    defer { AudioHardwareDestroyAggregateDevice(aggregateID) }

    var ioProc: AudioDeviceIOProcID?
    let queue = DispatchQueue(label: "permissions.system-io")
    guard AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregateID, queue, { _, _, _, _, _ in }) == noErr else { return false }
    defer {
        AudioDeviceDestroyIOProcID(aggregateID, ioProc!)
        queue.sync {}
    }
    guard AudioDeviceStart(aggregateID, ioProc) == noErr else { return false }
    AudioDeviceStop(aggregateID, ioProc)
    return true
}

/// Lets a progress callback that fires many times a second pass on only the first report of each new whole number.
final class ProgressThrottle: @unchecked Sendable {
    private let lock = NSLock()
    private var last = -1

    /// Returns whether `percent` is higher than every value reported before.
    func advance(to percent: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard percent > last else { return false }
        last = percent
        return true
    }
}
