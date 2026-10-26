import type { Summary, Transcript } from "../pipeline/pipeline.js";
import type { Meeting, Participant } from "../store/store.js";

/** The store setting behind the person's own name, which they give in onboarding or Settings. */
export const USER_NAME_SETTING = "userName";

/** The label the engine gives the microphone track, which is always the person using the app. */
const OWN_LABEL = "You";

/**
 * A copy of the Meeting with each renamed Participant's name in place of their label. Unnamed ones keep their label,
 * except the person's own, which takes `ownName` (when there is one) unless it was renamed in this Meeting.
 */
export function applyNames(meeting: Meeting, ownName?: string): Meeting {
  if (ownName) {
    meeting = {
      ...meeting,
      participants: meeting.participants.map((p) => (p.label === OWN_LABEL && !p.name ? { ...p, name: ownName } : p)),
    };
  }
  const names = new Map<string, string>();
  for (const p of meeting.participants) if (p.name) names.set(p.label, p.name);
  if (names.size === 0) return meeting;
  const name = (label: string): string => names.get(label) ?? label;
  const mentions = mentionsOf(meeting.participants);
  const say = (text: string): string => text.replace(mentions, (label) => name(label));
  const transcript: Transcript = {
    segments: meeting.transcript.segments.map((s) => ({ ...s, speaker: name(s.speaker) })),
  };
  const summary: Summary | null = meeting.summary && {
    ...meeting.summary,
    tldr: say(meeting.summary.tldr),
    participants: meeting.summary.participants.map((p) => ({ speaker: name(p.speaker), said: p.said.map(say) })),
  };
  return { ...meeting, transcript, summary };
}

/**
 * Matches a Participant's label standing alone in text ("Speaker 1" but not "Speaker 10"), longest first. Used on the
 * Summary, whose prose is written by a model that refers to Participants by label. Transcript text is speech, so it is
 * left as spoken.
 */
function mentionsOf(participants: Participant[]): RegExp {
  const labels = participants.map((p) => p.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\w])(?:${labels.join("|")})(?![\\w])`, "g");
}
