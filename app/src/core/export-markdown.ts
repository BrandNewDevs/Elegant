import { transcriptRevision } from "../pipeline/evidence.js";
import { applyNames } from "./participants.js";
import type { Meeting } from "../store/store.js";

const clock = (seconds: number): string => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A filename for the export, e.g. `zoom.us 2026-10-24 10-00.md`, with nothing a filesystem dislikes. */
export function exportFileName(meeting: Pick<Meeting, "app" | "startedAt">): string {
  const stamp = meeting.startedAt.slice(0, 16).replace("T", " ").replace(":", "-");
  return `${meeting.app} ${stamp}.md`.replace(/[\\/:*?"<>|]/g, "_");
}

/** One Meeting as Markdown: the Summary, then the Transcript. Renamed Participants appear by name, and so does the person (`ownName`). */
export function meetingToMarkdown(meeting: Meeting, ownName?: string): string {
  const original = meeting;
  const summary = original.summary;
  let evidence = summary?.evidence;
  // Validate against raw speaker labels before display names change the Transcript's fingerprint.
  if (evidence && (evidence.revision !== transcriptRevision(original.transcript)
      || !Array.isArray(evidence.participants) || evidence.participants.length !== summary!.participants.length
      || !evidence.participants.every((participant, index) => participant && participant.speaker === summary!.participants[index]!.speaker
        && Array.isArray(participant.said) && participant.said.length === summary!.participants[index]!.said.length))) evidence = undefined;
  const source = (refs: number[] | undefined, speaker?: string): string => {
    if (!evidence || !Array.isArray(refs) || !refs.length || refs.some(ref => !Number.isInteger(ref) || !original.transcript.segments[ref]
        || !Number.isFinite(original.transcript.segments[ref]!.start) || original.transcript.segments[ref]!.start < 0)) return "";
    if (speaker && !refs.some(ref => original.transcript.segments[ref]!.speaker === speaker)) return "";
    const ordered = [...new Set(refs)].sort((a, b) => original.transcript.segments[a]!.start - original.transcript.segments[b]!.start || a - b);
    const stamps = [...new Set(ordered.map(ref => clock(original.transcript.segments[ref]!.start)))];
    return ` (source ${stamps.join(", ")})`;
  };
  meeting = applyNames(original, ownName);

  const lines = [`# ${meeting.app}`, "", `Recorded ${meeting.startedAt}`];

  if (meeting.summary) {
    lines.push("", "## Summary", "", meeting.summary.tldr + source(evidence?.tldr));
    meeting.summary.participants.forEach((participant, index) => {
      const rawSpeaker = summary!.participants[index]!.speaker;
      lines.push("", `### ${participant.speaker}`, "", ...participant.said.map((point, pointIndex) =>
        `- ${point}${source(evidence?.participants[index]?.said[pointIndex], rawSpeaker)}`));
    });
  }

  if (meeting.transcript.segments.length > 0) {
    lines.push("", "## Transcript", "");
    for (const s of meeting.transcript.segments) lines.push(`**${s.speaker}** (${clock(s.start)}): ${s.text}`, "");
    lines.pop();
  }

  return lines.join("\n") + "\n";
}
