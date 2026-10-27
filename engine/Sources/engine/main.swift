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

/// A Recorder whose problems reach the app as `error` events.
func makeRecorder() throws -> Recorder {
    let made = try Recorder()
    made.onProblem = { send(["type": "error", "message": $0]) }
    return made
}

/// Detection: start holding the last few minutes in memory. Nothing is written until `start_recording`.
func startBuffer() {
    guard recorder == nil else { return } // already holding audio, or recording
    do {
        recorder = try makeRecorder()
    } catch {
        // Not fatal: `start_recording` tries again and reports its own failure.
        send(["type": "error", "message": "cannot hold audio before recording: \(error)"])
    }
}

/// The Prompt was declined or timed out. A Recording in progress is never touched.
func discardBuffer() {
    guard let held = recorder, !held.isRecording else { return }
    held.discard()
    recorder = nil
}

func startRecording(app: String) {
    if recorder?.isRecording == true {
        send(["type": "error", "message": "start_recording: a recording is already in progress"])
        return
    }
    do {
        // Keeps what `start_buffer` has held; without one, the Recording simply starts now.
        let held = try recorder ?? makeRecorder()
        recorder = held
        try held.beginRecording()
        send(["type": "recording_started", "app": app, "startedAt": isoFormatter.string(from: Date())])
    } catch {
        recorder?.discard()
        recorder = nil
        send(["type": "recording_failed", "message": "cannot start recording: \(error)"])
    }
}

func stopRecording() {
    guard let active = recorder, active.isRecording else {
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

let transcriber = Transcriber()

func transcribe(_ command: [String: Any]) {
    guard let id = command["id"] as? String,
          let micPath = command["micPath"] as? String,
          let systemPath = command["systemPath"] as? String,
          let model = command["model"] as? String,
          let modelsDirectory = command["modelsDirectory"] as? String else {
        send(["type": "error", "message": "malformed transcribe command"])
        return
    }
    Task {
        do {
            let segments = try await transcriber.transcribe(
                micPath: micPath, systemPath: systemPath, model: model, modelsDirectory: URL(fileURLWithPath: modelsDirectory)
            )
            send([
                "type": "transcript_ready",
                "id": id,
                "segments": segments.map { ["start": $0.start, "end": $0.end, "speaker": $0.speaker, "text": $0.text] },
            ])
        } catch {
            // Unload partially loaded models after a failed attempt, too. Busy operations reject this safely.
            try? await transcriber.releaseModels()
            send(["type": "transcription_failed", "id": id, "message": "\(error)"])
        }
    }
}

func releaseModels(_ command: [String: Any]) {
    guard let id = command["id"] as? String, !id.isEmpty, id.utf8.count <= 128 else {
        send(["type": "error", "message": "malformed release_models command"])
        return
    }
    Task {
        do {
            try await transcriber.releaseModels()
            send(["type": "models_released", "id": id])
        } catch {
            send(["type": "model_release_failed", "id": id, "message": "\(error)"])
        }
    }
}

func requestPermission(_ command: [String: Any]) {
    guard let permission = command["permission"] as? String, ["microphone", "system_audio"].contains(permission) else {
        send(["type": "error", "message": "malformed request_permission command"])
        return
    }
    // Both calls can wait on the user's answer, so they run off the command-reading thread.
    Task {
        let granted = permission == "microphone" ? await requestMicrophoneAccess() : requestSystemAudioAccess()
        send(["type": "permission_result", "permission": permission, "granted": granted])
    }
}

func checkPermission(_ command: [String: Any]) {
    guard let permission = command["permission"] as? String, ["microphone", "system_audio"].contains(permission) else {
        send(["type": "error", "message": "malformed check_permission command"])
        return
    }
    // System audio has no status call, so it is checked by starting a tap; that only prompts if the user never answered,
    // which is why the app asks for it only after a grant was recorded.
    Task {
        let granted = permission == "microphone" ? microphoneAccessGranted() : requestSystemAudioAccess()
        send(["type": "permission_result", "permission": permission, "granted": granted])
    }
}

func downloadModels(_ command: [String: Any]) {
    guard let model = command["model"] as? String, let modelsDirectory = command["modelsDirectory"] as? String else {
        send(["type": "error", "message": "malformed download_models command"])
        return
    }
    Task {
        // WhisperKit reports far more often than the app needs; only whole percents go up.
        let lastPercent = ProgressThrottle()
        do {
            try await transcriber.prepare(model: model, modelsDirectory: URL(fileURLWithPath: modelsDirectory)) { fraction in
                if lastPercent.advance(to: Int(fraction * 100)) {
                    send(["type": "model_download_progress", "model": model, "fraction": fraction])
                }
            }
            try await transcriber.releaseModels()
            send(["type": "models_ready"])
        } catch {
            // A partially prepared model must not remain resident after a failed preparation.
            try? await transcriber.releaseModels()
            send(["type": "model_download_failed", "message": "\(error)"])
        }
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
    case "transcribe":
        transcribe(command)
    case "request_permission":
        requestPermission(command)
    case "check_permission":
        checkPermission(command)
    case "download_models":
        downloadModels(command)
    case "release_models":
        releaseModels(command)
    case "start_buffer":
        startBuffer()
    case "discard_buffer":
        discardBuffer()
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
