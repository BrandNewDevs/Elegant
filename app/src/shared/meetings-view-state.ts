import type { Meeting, MeetingListItem } from "../store/store.js";

/** What the main window is showing: the Meetings list or the Settings page. */
export type MeetingsView = "meetings" | "settings";

export type MeetingsViewState = {
  view: MeetingsView;
  meetings: MeetingListItem[];
  selected: Meeting | undefined;
  query: string;
};
