import type { SetupState } from "../setup/setup.js";
import type { AISettingsView } from "./ai-settings.js";

export type SetupViewState = {
  /** The app's display name. */
  name: string;
  /** The person's own name; empty until they give one. */
  userName: string;
  permissionsGranted: boolean;
  state: SetupState;
  ai?: AISettingsView;
};
