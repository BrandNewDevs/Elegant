// Watches which processes use the microphone, by polling CoreAudio process objects.
// Reading them needs no permission. Browsers and Electron apps run audio in helper processes, so each
// process is reported as the outermost app in its executable path.
import CoreAudio
import Foundation

struct MicEdge {
    var started: Bool
    var app: String
    var pid: Int32
}

/// Not thread-safe: call `poll()` from one queue only.
final class MicWatcher {
    private struct Snapshot {
        var pid: pid_t
        var app: String?
        var input: Bool
    }

    private var known: [AudioObjectID: Snapshot] = [:]
    private let onEdge: (MicEdge) -> Void

    init(onEdge: @escaping (MicEdge) -> Void) {
        self.onEdge = onEdge
    }

    func poll() {
        var seen = Set<AudioObjectID>()
        for id in processObjects() {
            seen.insert(id)
            let old = known[id]
            let pid = pid_t(bitPattern: u32(id, kAudioProcessPropertyPID) ?? 0)
            let input = (u32(id, kAudioProcessPropertyIsRunningInput) ?? 0) != 0
            // The path is only needed (and only reliably readable) while the process is alive.
            let app = old?.app ?? outerAppName(executablePath(pid))
            known[id] = Snapshot(pid: pid, app: app, input: input)
            if input != (old?.input ?? false) { report(started: input, app: app, pid: pid) }
        }
        for (id, old) in known where !seen.contains(id) {
            if old.input { report(started: false, app: old.app, pid: old.pid) }
            known[id] = nil
        }
    }

    private func report(started: Bool, app: String?, pid: pid_t) {
        guard let app else { return } // not inside an .app, so it cannot be a call app
        onEdge(MicEdge(started: started, app: app, pid: pid))
    }

    private func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    private func u32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var addr = address(selector)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
    }

    private func processObjects() -> [AudioObjectID] {
        var addr = address(kAudioHardwarePropertyProcessObjectList)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    private func executablePath(_ pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 4096)
        return proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : nil
    }
}

/// "/Applications/Google Chrome.app/Contents/Frameworks/.../Helper.app/Contents/MacOS/Helper" -> "Google Chrome"
func outerAppName(_ path: String?) -> String? {
    guard let path, let range = path.range(of: ".app/") ?? path.range(of: ".app", options: .backwards) else { return nil }
    let bundle = String(path[..<range.lowerBound])
    let name = (bundle as NSString).lastPathComponent
    return name.isEmpty ? nil : name
}
