// The Meeting Recorder engine. Speaks the JSON-lines protocol on stdio; see app/src/engine/protocol.ts.
// Reports which processes use the microphone and obeys shutdown. Recording arrives in a later ticket.
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
    case "discard_buffer":
        break // nothing is buffered until recording exists
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
