import { ChatPanel } from "./ChatPanel";
import { JobStatus } from "./JobStatus";
import { AlertCircle, FileDown, FileText, Loader2, MessageSquare, Radio, RefreshCw, Sparkles, Trash2, Users, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Meeting } from "../../store/store";
import type { MeetingsViewState } from "../../shared/meetings-view-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { formatClock, formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Citations } from "./Citations";

type View = "summary" | "transcript" | "chat";
const VIEWS: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "summary", label: "Summary", icon: Sparkles },
  { id: "transcript", label: "Transcript", icon: FileText },
  { id: "chat", label: "Chat", icon: MessageSquare },
];

function Heading({ children, icon: Icon }: { children: ReactNode; icon: LucideIcon }) {
  return <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Icon className="size-3.5" aria-hidden />{children}</h2>;
}

export function MeetingDetail({ meeting, chat, jobs, isCurrent }: {
  meeting: Meeting; chat: MeetingsViewState["chat"]; jobs: MeetingsViewState["jobs"]; isCurrent: () => boolean;
}) {
  const [view, setView] = useState<View>("summary");
  const [error, setError] = useState("");
  const [highlighted, setHighlighted] = useState<number[]>([]);
  const segments = useRef(new Map<number, HTMLParagraphElement>());
  const tabs = useRef(new Map<View, HTMLButtonElement>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && isCurrent();
  const busy = meeting.state === "recording" || meeting.state === "processing";
  async function action(work: () => Promise<void>) {
    setError("");
    try { await work(); } catch (problem) { if (current()) setError(problem instanceof Error ? problem.message : "The action could not finish. Try again."); }
  }
  function openEvidence(revision: string, refs: number[]) {
    void action(async () => {
      const resolved = await window.electron.meetings.openReference({ meetingId: meeting.id, revision, refs });
      if (!current() || revision !== chat?.revision) return;
      setHighlighted(resolved);
      setView("transcript");
    });
  }
  useEffect(() => {
    if (view !== "transcript" || !highlighted.length) return;
    const element = segments.current.get(highlighted[0]!);
    element?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    element?.focus({ preventScroll: true });
  }, [view, highlighted]);

  return <div className="space-y-5">
    <header className="space-y-3 pb-1">
      <div><h1 className="text-xl font-semibold tracking-tight">{meeting.app}</h1><p className="mt-1 text-sm text-muted-foreground">{formatWhen(meeting.startedAt)}</p></div>
      {!busy && <div className="flex flex-wrap gap-2">
        {meeting.transcript.segments.length > 0 && <Button type="button" variant="secondary" size="sm" onClick={() => void action(() => window.electron.meetings.regenerate(meeting.id))}><RefreshCw aria-hidden />Regenerate Summary</Button>}
        <Button type="button" variant="outline" size="sm" onClick={() => window.electron.meetings.export(meeting.id)}><FileDown aria-hidden />Export to Markdown…</Button>
        <Button type="button" variant="destructive" size="sm" onClick={() => void action(() => window.electron.meetings.delete(meeting.id))}><Trash2 aria-hidden />Delete Meeting</Button>
      </div>}
    </header>
    <JobStatus jobs={jobs ?? []} meetingId={meeting.id} onCancel={jobId => void action(() => window.electron.meetings.cancelJob({ meetingId: meeting.id, jobId }))} />
    <Separator />
    {error && <Alert variant="destructive" role="alert"><AlertCircle className="size-4" aria-hidden /><AlertDescription>{error}</AlertDescription></Alert>}
    {meeting.state === "recording" && <Alert variant="warning"><Radio className="size-4" aria-hidden /><AlertDescription>This Meeting is being recorded.</AlertDescription></Alert>}
    {meeting.state === "processing" && <Alert variant="warning"><Loader2 className="size-4 animate-spin" aria-hidden /><AlertDescription>Processing this Meeting. Completed Transcript passages remain available below.</AlertDescription></Alert>}
    {meeting.state === "failed" && <Alert variant="destructive"><AlertCircle className="size-4" aria-hidden /><AlertDescription>Processing failed: {meeting.error ?? "unknown error"}. A completed Transcript can still be used for chat.</AlertDescription></Alert>}
    {meeting.state === "done" && !meeting.transcript.segments.length && <p className="text-sm text-muted-foreground">No speech was detected in this Recording.</p>}
    {meeting.participants.length > 0 && <section aria-label="Participants">
      <Heading icon={Users}>Participants</Heading>
      <div className="space-y-2">{meeting.participants.map(participant => <form key={`${participant.label}:${participant.name}`} className="flex flex-wrap items-center gap-2" onSubmit={event => {
        event.preventDefault();
        const name = (event.currentTarget.elements.namedItem("name") as HTMLInputElement).value;
        window.electron.meetings.rename({ meetingId: meeting.id, label: participant.label, name });
      }}>
        <label className="w-24 shrink-0 text-xs text-muted-foreground" htmlFor={`participant-${meeting.id}-${participant.label}`}>{participant.label}</label>
        <Input id={`participant-${meeting.id}-${participant.label}`} name="name" className="max-w-xs flex-1" defaultValue={participant.name ?? ""} placeholder="Name" />
        <Button type="submit" size="sm">Rename</Button>
      </form>)}</div>
    </section>}
    <div role="tablist" aria-label="Meeting views" className="flex gap-1 border-b">
      {VIEWS.map(({ id, label, icon: Icon }) => <button key={id} ref={element => { if (element) tabs.current.set(id, element); else tabs.current.delete(id); }} type="button" role="tab"
        id={`meeting-${meeting.id}-${id}-tab`} aria-controls={`meeting-${meeting.id}-${id}-panel`} aria-selected={view === id} tabIndex={view === id ? 0 : -1}
        className={cn("-mb-px flex items-center gap-2 border-b-2 px-4 py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", view === id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
        onClick={() => setView(id)} onKeyDown={event => {
          const index = VIEWS.findIndex(item => item.id === id);
          const target = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : undefined;
          if (target !== undefined) { event.preventDefault(); const next = VIEWS[target]!.id; setView(next); tabs.current.get(next)?.focus(); }
        }}><Icon className="size-4" aria-hidden />{label}</button>)}
    </div>
    <section role="tabpanel" id={`meeting-${meeting.id}-${view}-panel`} aria-labelledby={`meeting-${meeting.id}-${view}-tab`} className="min-w-0">
      {view === "summary" && (meeting.summary ? <div className="space-y-6">
        <div><Heading icon={Sparkles}>TL;DR</Heading><p className="text-sm leading-relaxed">{meeting.summary.tldr}{meeting.summary.evidence && <Citations revision={meeting.summary.evidence.revision} refs={meeting.summary.evidence.tldr} transcript={meeting.transcript} onOpen={openEvidence} />}</p></div>
        {meeting.summary.participants.map((participant, index) => <div key={participant.speaker}>
          <h3 className="font-medium">{participant.speaker}</h3>
          <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">{participant.said.map((point, pointIndex) => <li key={pointIndex}>{point}{meeting.summary?.evidence && <Citations revision={meeting.summary.evidence.revision} refs={meeting.summary.evidence.participants[index]?.said[pointIndex] ?? []} transcript={meeting.transcript} onOpen={openEvidence} />}</li>)}</ul>
        </div>)}
        {!meeting.summary.evidence && <p className="border-t pt-4 text-xs text-muted-foreground">This Summary has no Transcript references. Regenerate it to add supporting passages.</p>}
      </div> : <p className="py-8 text-sm text-muted-foreground">{busy ? "The Summary will appear after processing." : "No Summary yet. You can read the Transcript or ask about this Meeting."}</p>)}
      {view === "transcript" && <div className="space-y-2">{meeting.transcript.segments.length ? meeting.transcript.segments.map((segment, index) => <p key={index}
        ref={element => { if (element) segments.current.set(index, element); else segments.current.delete(index); }}
        tabIndex={-1} data-segment-ref={index} data-highlighted={highlighted.includes(index) ? "true" : undefined}
        aria-label={`Transcript at ${formatClock(segment.start)}`}
        className={cn("rounded-r-md border-l-2 p-3 text-sm leading-relaxed outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", highlighted.includes(index) ? "border-primary bg-primary/10" : "border-border")}>
        <span className="mr-2 font-mono text-xs text-muted-foreground">{formatClock(segment.start)}</span><strong>{segment.speaker}</strong> {segment.text}
      </p>) : <p className="py-8 text-sm text-muted-foreground">No Transcript is available yet.</p>}</div>}
      <div hidden={view !== "chat"}><ChatPanel meetingId={meeting.id} chat={chat} transcript={meeting.transcript} onOpen={openEvidence} isCurrent={current} /></div>
    </section>
  </div>;
}
