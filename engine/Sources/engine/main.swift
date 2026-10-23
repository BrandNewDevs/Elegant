// The Meeting Recorder engine. Speaks the JSON-lines protocol on stdio; see app/src/engine/protocol.ts.
// Walking skeleton: reports ready and obeys shutdown. Detection and capture arrive in later tickets.
import Foundation

let version = "0.1.0"

setvbuf(stdout, nil, _IOLBF, 0)

func send(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

send(["type": "ready", "version": version])

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = command["type"] as? String else {
        send(["type": "error", "message": "malformed command: \(line.prefix(200))"])
        continue
    }
    switch type {
    case "shutdown":
        exit(0)
    default:
        send(["type": "error", "message": "command not implemented yet: \(type)"])
    }
}
// stdin closed: the app is gone, so there is nothing left to serve.
exit(0)
