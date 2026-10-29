import type { ActiveRecording } from "../core/app-core.js";
import type { UpdateState } from "../core/updater.js";
import type { AIJobState } from "../pipeline/job-queue.js";
import type { ChatRecord } from "./meeting-chat.js";
import type { Meeting, MeetingListItem } from "../store/store.js";

export type MeetingsViewState = {
  /** Whether the Settings page is open in the main area. */
  settingsOpen: boolean;
  /** The "Show in Dock" setting, shown in Settings. */
  showInDock: boolean;
  /** The "Check for updates" setting, shown in Settings. */
  checkForUpdates: boolean;
  meetings: MeetingListItem[];
  selected: Meeting | undefined;
  query: string;
  /** Present for a selected Meeting in production; optional for older renderer state fixtures. */
  chat?: { history: ChatRecord[]; available: boolean; revision: string };
  jobs?: AIJobState[];
  /** The Recording in progress, shown at the foot of the sidebar with a Stop button. */
  recording?: ActiveRecording;
  /** Where an update stands: the sidebar and Settings show it for as long as it is ready. Idle in a run from source. */
  update?: UpdateState;
  /** The running app's version, shown in Settings. */
  appVersion?: string;
};
