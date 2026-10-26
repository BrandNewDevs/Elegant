import type { SetupState } from "../setup/first-run-setup.js";

export type SetupViewState = {
  name: string;
  complete: boolean;
  state: SetupState;
};
