import type { ActiveRecording } from "../core/app-core.js";
import type { UpdateState } from "../core/updater.js";
import type { AIJobState } from "../pipeline/job-queue.js";
import type { Appearance } from "./appearance.js";
import type { ChatRecord } from "./meeting-chat.js";
import type { Meeting, MeetingListItem } from "../store/store.js";

export type MeetingsViewState = {
  /** The app's display name, shown centred in the window's title strip. Absent in older renderer state fixtures. */
  appName?: string;
  /** Whether the Settings page is open in the main area. */
  settingsOpen: boolean;
  /** The "Show in Dock" setting, shown in Settings. */
  showInDock: boolean;
  /** The Appearance setting, shown in Settings. Absent in older renderer state fixtures. */
  appearance?: Appearance;
  /** The Summary model setting, shown in Settings. Absent in older renderer state fixtures. */
  summaryModel?: string;
  /** The "Keep audio after transcription" setting, shown in Settings. Absent in older renderer state fixtures. */
  keepAudio?: boolean;
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
