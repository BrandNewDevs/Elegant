import type { SetupState } from "../setup/setup.js";

export type SetupViewState = {
  name: string;
  permissionsGranted: boolean;
  state: SetupState;
};
