import { ChatPanel } from "./ChatPanel";
import { AlertCircle, CheckCircle2, Ellipsis, FileDown, FileText, Hourglass, MessageSquare, Radio, RefreshCw, Sparkles, Trash2, Users, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Meeting } from "../../store/store";
import type { MeetingsViewState } from "../../shared/meetings-view-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MenuItem, Popover } from "@/components/ui/popover";
import { formatClock, formatWhen } from "@/lib/format";
import type { MeetingState } from "../../store/store";
import { cn } from "@/lib/utils";
import { Citations } from "./Citations";

type View = "summary" | "transcript" | "chat";
const VIEWS: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "summary", label: "Summary", icon: Sparkles },
  { id: "transcript", label: "Transcript", icon: FileText },
  { id: "chat", label: "Chat", icon: MessageSquare },
];

// Work in progress is also shown as toasts (see job-toasts.tsx), so nothing here spins.
const STATE_BADGE: Record<MeetingState, { label: string; variant: "warning" | "destructive" | "success"; icon: LucideIcon }> = {
  recording: { label: "Recording", variant: "warning", icon: Radio },
  processing: { label: "Processing", variant: "warning", icon: Hourglass },
  done: { label: "Done", variant: "success", icon: CheckCircle2 },
  failed: { label: "Failed", variant: "destructive", icon: AlertCircle },
};

function StateBadge({ state }: { state: MeetingState }) {
  const { label, variant, icon: Icon } = STATE_BADGE[state];
  return (
    <Badge variant={variant}>
      <Icon className="size-3" aria-hidden />
      {label}
    </Badge>
  );
}

function Heading({ children, icon: Icon }: { children: ReactNode; icon: LucideIcon }) {
  return <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Icon className="size-3.5" aria-hidden />{children}</h2>;
}

export function MeetingDetail({ meeting, chat, isCurrent }: {
  meeting: Meeting; chat: MeetingsViewState["chat"]; isCurrent: () => boolean;
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

  return <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight">{meeting.app}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{formatWhen(meeting.startedAt)}<StateBadge state={meeting.state} /></p>
      </div>
      {!busy && <div className="flex shrink-0 gap-1.5">
        {meeting.participants.length > 0 && <Popover label="Participants" className="w-80 p-3" trigger={props => <Button type="button" variant="outline" size="sm" {...props}><Users aria-hidden />Participants</Button>}>
          <h2 className="mb-2 text-xs font-medium text-muted-foreground">Rename Participants</h2>
          <div className="space-y-2">{meeting.participants.map(participant => <form key={`${participant.label}:${participant.name}`} className="flex items-center gap-2" onSubmit={event => {
            event.preventDefault();
            const name = (event.currentTarget.elements.namedItem("name") as HTMLInputElement).value;
            window.electron.meetings.rename({ meetingId: meeting.id, label: participant.label, name });
          }}>
            <label className="w-20 shrink-0 text-xs text-muted-foreground" htmlFor={`participant-${meeting.id}-${participant.label}`}>{participant.label}</label>
            <Input id={`participant-${meeting.id}-${participant.label}`} name="name" className="h-8 min-w-0 flex-1" defaultValue={participant.name ?? ""} placeholder="Name" />
            <Button type="submit" size="sm">Rename</Button>
          </form>)}</div>
        </Popover>}
        <Popover role="menu" label="Meeting actions" trigger={props => <Button type="button" variant="outline" size="icon" className="size-8" aria-label="More actions" {...props}><Ellipsis aria-hidden /></Button>}>
          {meeting.transcript.segments.length > 0 && <MenuItem onClick={() => void action(() => window.electron.meetings.regenerate(meeting.id))}><RefreshCw aria-hidden />Regenerate Summary</MenuItem>}
          <MenuItem onClick={() => window.electron.meetings.export(meeting.id)}><FileDown aria-hidden />Export to Markdown…</MenuItem>
          <div role="separator" className="my-1 h-px bg-border" />
          <MenuItem className="text-destructive" onClick={() => void action(() => window.electron.meetings.delete(meeting.id))}><Trash2 aria-hidden />Delete Meeting…</MenuItem>
        </Popover>
      </div>}
    </header>
    {error && <Alert variant="destructive" role="alert"><AlertCircle className="size-4" aria-hidden /><AlertDescription>{error}</AlertDescription></Alert>}
    {meeting.state === "recording" && <Alert variant="warning"><Radio className="size-4" aria-hidden /><AlertDescription>This Meeting is being recorded.</AlertDescription></Alert>}
    {meeting.state === "failed" && <Alert variant="destructive"><AlertCircle className="size-4" aria-hidden /><AlertDescription>Processing failed: {meeting.error ?? "unknown error"}. A completed Transcript can still be used for chat.</AlertDescription></Alert>}
    {meeting.state === "done" && !meeting.transcript.segments.length && <p className="text-sm text-muted-foreground">No speech was detected in this Recording.</p>}
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
        {meeting.summary.generation?.provider === "gemini" && <p className="text-xs text-muted-foreground">Generated with Gemini · {meeting.summary.generation.model}</p>}
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
