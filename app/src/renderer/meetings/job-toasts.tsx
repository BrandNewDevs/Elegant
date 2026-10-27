import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { AIJobState } from "../../pipeline/job-queue";
import type { MeetingListItem } from "../../store/store";

/** What a job is doing while it runs, and what it leaves behind when it succeeds. */
const WORDING: Record<string, { running: string; done: string }> = {
  "speech-model-preparation": { running: "Preparing speech models", done: "Speech models ready" },
  transcription: { running: "Transcribing Meeting", done: "Transcript ready" },
  "transcription-and-summary": { running: "Transcribing Meeting", done: "Meeting processed" },
  summary: { running: "Writing Summary", done: "Summary ready" },
};

const meetingOf = (job: AIJobState): number | undefined => {
  const match = /^meeting:(\d+)$/.exec(job.owner);
  return match ? Number(match[1]) : undefined;
};

/** A job that has left the queue, waiting for its Meeting to say how it went. */
type Finished = { job: AIJobState; meetingId: number };

/**
 * One toast per AI job in place of loaders on the page: it spins while the job waits or runs, and turns into the
 * outcome when the Meeting settles. Chat answers are not toasted; the conversation already shows them.
 */
export function useJobToasts(jobs: AIJobState[] | undefined, meetings: MeetingListItem[]): void {
  const shown = useRef(new Map<string, AIJobState>());
  const finished = useRef(new Map<string, Finished>());

  useEffect(() => {
    const current = new Map((jobs ?? []).filter(job => WORDING[job.kind]).map(job => [job.id, job]));
    for (const job of current.values()) {
      const meetingId = meetingOf(job);
      const wording = WORDING[job.kind]!;
      // A queued summary or any queued job can be cancelled; one already transcribing cannot be interrupted.
      const cancellable = meetingId !== undefined && (job.status === "queued" || job.kind === "summary");
      toast.loading(job.status === "queued" ? `${wording.running} (queued)` : wording.running, {
        id: job.id,
        duration: Infinity,
        dismissible: false,
        description: meetings.find(m => m.id === meetingId)?.app,
        action: cancellable ? { label: "Cancel", onClick: () => void window.electron.meetings.cancelJob({ meetingId, jobId: job.id }) } : undefined,
      });
      shown.current.set(job.id, job);
    }
    for (const [id, job] of shown.current) {
      if (current.has(id)) continue;
      shown.current.delete(id);
      const meetingId = meetingOf(job);
      if (meetingId === undefined) toast.success(WORDING[job.kind]!.done, { id, duration: 4000, dismissible: true });
      else finished.current.set(id, { job, meetingId });
    }
    // The queue lets go of a job a moment before the Meeting is marked done or failed, so the outcome waits for that.
    for (const [id, { job, meetingId }] of finished.current) {
      const meeting = meetings.find(m => m.id === meetingId);
      if (!meeting) { toast.dismiss(id); finished.current.delete(id); continue; }
      if (meeting.state === "done") toast.success(WORDING[job.kind]!.done, { id, duration: 4000, dismissible: true, description: meeting.app, action: undefined });
      else if (meeting.state === "failed") toast.error(`${WORDING[job.kind]!.running} failed`, { id, duration: 8000, dismissible: true, description: meeting.app, action: undefined });
      else continue;
      finished.current.delete(id);
    }
  }, [jobs, meetings]);
}
