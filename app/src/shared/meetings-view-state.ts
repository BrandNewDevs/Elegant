import type { Meeting, MeetingListItem } from "../store/store.js";

export type MeetingsViewState = {
  meetings: MeetingListItem[];
  selected: Meeting | undefined;
  query: string;
};
