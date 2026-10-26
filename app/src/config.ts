/** The product's display name. It will change; keep it here and nowhere else. */
export const DISPLAY_NAME = "Elegant";

/** Permanent: macOS ties permissions and the login item to it. Never derive it from the display name. */
export const BUNDLE_ID = "dev.bnd.meetingrecorder";

/** The WhisperKit variant that transcribes Recordings. A starting choice, to be settled by the accuracy evaluation in docs/ai-brief.md. */
export const SPEECH_MODEL = "large-v3-v20240930_626MB";
