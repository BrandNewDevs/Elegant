import type { Meeting, MeetingListItem } from "../store/store.js";

export type MeetingsViewState = {
  /** Whether the Settings dialog is open over the Meetings. */
  settingsOpen: boolean;
  /** The "Show in Dock" setting, shown in the Settings dialog. */
  showInDock: boolean;
  meetings: MeetingListItem[];
  selected: Meeting | undefined;
  query: string;
};
