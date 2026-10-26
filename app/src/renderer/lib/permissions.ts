import { Mic, Volume2, type LucideIcon } from "lucide-react";
import type { SetupAction } from "../../shared/setup-actions";
import type { SetupState } from "../../setup/setup";

export interface PermissionCopy {
  key: "microphone" | "systemAudio";
  title: string;
  icon: LucideIcon;
  /** What the permission is for. */
  purpose: (name: string) => string;
  allowLabel: string;
  action: SetupAction;
  settingsAction: SetupAction;
}

export const PERMISSIONS: Record<PermissionCopy["key"], PermissionCopy> = {
  microphone: {
    key: "microphone",
    title: "Microphone",
    icon: Mic,
    purpose: (name) => `${name} records what you say in a call through your microphone.`,
    allowLabel: "Allow microphone",
    action: "microphone",
    settingsAction: "settings-microphone",
  },
  systemAudio: {
    key: "systemAudio",
    title: "System audio",
    icon: Volume2,
    purpose: (name) => `${name} records what the other people say by capturing your Mac's audio output.`,
    allowLabel: "Allow system audio",
    action: "system-audio",
    settingsAction: "settings-system-audio",
  },
};

/** Said in onboarding before the button that makes macOS show its prompt, so the prompt is never a surprise. */
export const PROMPT_NOTE = "When you press the button, macOS asks whether to allow it.";

export type PermissionStep = SetupState["microphone"];
