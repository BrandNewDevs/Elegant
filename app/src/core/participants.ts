import type { Summary, Transcript } from "../pipeline/pipeline.js";
import type { Meeting, Participant } from "../store/store.js";

/** The store setting behind the person's own name, which they give in onboarding or Settings. */
export const USER_NAME_SETTING = "userName";

/** The label the engine gives the microphone track, which is always the person using the app. */
const OWN_LABEL = "You";

/** Per-Meeting renames take precedence over the current global name for the microphone Participant. */
export function effectiveParticipants(participants: Participant[], ownName?: string): Participant[] {
  return ownName
    ? participants.map(participant => participant.label === OWN_LABEL && !participant.name ? { ...participant, name: ownName } : participant)
    : participants;
}

/**
 * A copy of the Meeting with each renamed Participant's name in place of their label. Unnamed ones keep their label,
 * except the person's own, which takes `ownName` (when there is one) unless it was renamed in this Meeting.
 */
export function applyNames(meeting: Meeting, ownName?: string): Meeting {
  if (ownName) {
    meeting = {
      ...meeting,
      participants: effectiveParticipants(meeting.participants, ownName),
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


/** Display generated text using current names; stored labels and source references stay stable. */
export function displayParticipantMentions(text: string, participants: Participant[]): string {
  if (!participants.length) return text;
  const names = new Map(participants.filter(participant => participant.name).map(participant => [participant.label, participant.name!]));
  return text.replace(mentionsOf(participants), label => names.get(label) ?? label);
}

/** Resolve unambiguous display names at submission, then persist canonical labels for later renames. */
export function canonicaliseParticipantMentions(text: string, participants: Participant[]): string {
  const aliases = new Map<string, { name: string; labels: Set<string> }>();
  const labels = new Map(participants.map(participant => [participant.label.toLowerCase(), participant.label]));
  for (const participant of participants) {
    if (!participant.name) continue;
    const key = participant.name.toLowerCase();
    const entry = aliases.get(key) ?? { name: participant.name, labels: new Set<string>() };
    entry.labels.add(participant.label);
    aliases.set(key, entry);
  }
  if (!aliases.size) return text;
  const escaped = [...aliases.values()].map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  const expression = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  return text.replace(expression, name => {
    const entry = aliases.get(name.toLowerCase())!;
    const canonical = [...entry.labels][0]!;
    const collidingLabel = labels.get(name.toLowerCase());
    if (entry.labels.size !== 1 || (collidingLabel && collidingLabel !== canonical)) {
      throw new Error(`The Participant name "${entry.name}" is ambiguous. Give Participants distinct names before asking about them.`);
    }
    return canonical;
  });
}
