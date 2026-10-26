import type { SetupState } from "../setup/setup.js";

export type SetupViewState = {
  /** The app's display name. */
  name: string;
  /** The person's own name; empty until they give one. */
  userName: string;
  permissionsGranted: boolean;
  state: SetupState;
};
