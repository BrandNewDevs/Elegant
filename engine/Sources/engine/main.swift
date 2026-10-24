// The Meeting Recorder engine. Speaks the JSON-lines protocol on stdio; see app/src/engine/protocol.ts.
// Reports which processes use the microphone, records two tracks on request, and obeys shutdown.
import Foundation

let version = "0.1.0"

setvbuf(stdout, nil, _IOLBF, 0)

// Events come from the poll timer and the reply loop on different threads; one lock keeps lines whole.
let outputLock = NSLock()

func send(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else { return }
    outputLock.lock()
    print(line)
    outputLock.unlock()
}

send(["type": "ready", "version": version])

let micWatcher = MicWatcher { edge in
    send(["type": edge.started ? "mic_in_use_started" : "mic_in_use_stopped", "app": edge.app, "pid": edge.pid])
}
let pollTimer = DispatchSource.makeTimerSource(queue: .main)
pollTimer.schedule(deadline: .now(), repeating: .milliseconds(100))
pollTimer.setEventHandler { micWatcher.poll() }
pollTimer.resume()

// Only touched from the command-reading thread.
var recorder: Recorder?
let isoFormatter = ISO8601DateFormatter()
isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

func startRecording(app: String) {
    guard recorder == nil else {
        send(["type": "error", "message": "start_recording: a recording is already in progress"])
        return
    }
    do {
        recorder = try Recorder()
        send(["type": "recording_started", "app": app, "startedAt": isoFormatter.string(from: Date())])
    } catch {
        send(["type": "recording_failed", "message": "cannot start recording: \(error)"])
    }
}

func stopRecording() {
    guard let active = recorder else {
        send(["type": "recording_failed", "message": "stop_recording: no recording is in progress"])
        return
    }
    recorder = nil
    do {
        let tracks = try active.finish()
        send([
            "type": "tracks_ready",
            "micPath": tracks.micPath,
            "systemPath": tracks.systemPath,
            "micStartHostTime": tracks.micStartHostTime,
            "systemStartHostTime": tracks.systemStartHostTime,
        ])
    } catch {
        send(["type": "recording_failed", "message": "\(error)"])
    }
}

func handle(command line: String) {
    guard let data = line.data(using: .utf8),
          let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = command["type"] as? String else {
        send(["type": "error", "message": "malformed command: \(line.prefix(200))"])
        return
    }
    switch type {
    case "shutdown":
        exit(0)
    case "start_recording":
        startRecording(app: command["app"] as? String ?? "")
    case "stop_recording":
        stopRecording()
    case "discard_buffer":
        break // nothing is buffered before a Recording starts yet
    default:
        send(["type": "error", "message": "command not implemented yet: \(type)"])
    }
}

Thread.detachNewThread {
    while let line = readLine() { handle(command: line) }
    // stdin closed: the app is gone, so there is nothing left to serve.
    exit(0)
}
dispatchMain()
