import { Loader2, Square } from "lucide-react";
import type { AIJobState } from "../../pipeline/job-queue";
import { Button } from "@/components/ui/button";

const LABELS: Record<string, string> = { "speech-model-preparation": "Preparing speech models", "transcription-and-summary": "Transcribing Meeting", summary: "Writing Summary", "meeting-chat": "Answering question" };
export function JobStatus({ jobs, meetingId, onCancel }: { jobs: AIJobState[]; meetingId?: number; onCancel?: (jobId: string) => void }) {
  const selected = meetingId === undefined ? jobs : jobs.filter(job => job.owner === `meeting:${meetingId}` || job.owner === `chat:${meetingId}`);
  if (!selected.length) return null;
  return <div aria-label={meetingId === undefined ? "Local AI queue" : "Meeting AI work"} className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
    <p className="font-medium">{meetingId === undefined ? "Local AI" : "This Meeting"} · {selected.length} {selected.length === 1 ? "job" : "jobs"}</p>
    {selected.map(job => <div key={job.id} className="flex items-center justify-between gap-2 text-muted-foreground">
      <span className="flex items-center gap-2">{job.status === "running" && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}{LABELS[job.kind] ?? "Processing locally"}<span className="text-[10px] uppercase tracking-wide">{job.status === "queued" ? "Queued" : "Running"}</span></span>
      {onCancel && (job.status === "queued" || job.kind === "summary" || job.kind === "meeting-chat") && <Button type="button" variant="ghost" size="sm" aria-label={`Cancel ${LABELS[job.kind] ?? "AI job"}`} onClick={() => onCancel(job.id)}><Square aria-hidden />Cancel</Button>}
    </div>)}
  </div>;
}
