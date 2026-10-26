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

/** One Meeting as Markdown: the Summary, then the Transcript. Renamed Participants appear by name. */
export function meetingToMarkdown(meeting: Meeting): string {
  const names = new Map(meeting.participants.flatMap((p) => (p.name ? [[p.label, p.name] as const] : [])));
  const nameOf = (label: string): string => names.get(label) ?? label;

  const lines = [`# ${meeting.app}`, "", `Recorded ${meeting.startedAt}`];

  if (meeting.summary) {
    lines.push("", "## Summary", "", meeting.summary.tldr);
    for (const p of meeting.summary.participants) {
      lines.push("", `### ${nameOf(p.speaker)}`, "", ...p.said.map((s) => `- ${s}`));
    }
  }

  if (meeting.transcript.segments.length > 0) {
    lines.push("", "## Transcript", "");
    for (const s of meeting.transcript.segments) lines.push(`**${nameOf(s.speaker)}** (${clock(s.start)}): ${s.text}`, "");
    lines.pop();
  }

  return lines.join("\n") + "\n";
}
