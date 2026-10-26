import type { AIJobState } from "../pipeline/job-queue.js";
import type { ChatRecord } from "./meeting-chat.js";
import type { Meeting, MeetingListItem } from "../store/store.js";

export type MeetingsViewState = {
  /** Whether the Settings dialog is open over the Meetings. */
  settingsOpen: boolean;
  /** The "Show in Dock" setting, shown in the Settings dialog. */
  showInDock: boolean;
  meetings: MeetingListItem[];
  selected: Meeting | undefined;
  query: string;
  /** Present for a selected Meeting in production; optional for older renderer state fixtures. */
  chat?: { history: ChatRecord[]; available: boolean; revision: string };
  jobs?: AIJobState[];
};
