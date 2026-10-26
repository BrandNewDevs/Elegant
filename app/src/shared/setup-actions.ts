/** Actions the onboarding and settings windows can request from the main process. */
export const SETUP_ACTIONS = [
  "microphone",
  "system-audio",
  "models",
  "ollama",
  "settings-microphone",
  "settings-system-audio",
  "open-settings",
  "done",
] as const;

export type SetupAction = (typeof SETUP_ACTIONS)[number];
