import { AlertCircle, CheckCircle2, FileDown, FileText, Inbox, Loader2, MessagesSquare, Radio, RefreshCw, Search, Settings, Sparkles, Trash2, Users, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Meeting, MeetingListItem, MeetingState } from "../../store/store";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { formatClock, formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SettingsDialog } from "../settings/SettingsDialog";

const STATE_LABEL: Record<MeetingState, string> = {
  recording: "Recording",
  processing: "Processing",
  done: "Done",
  failed: "Failed",
};

const STATE_BADGE: Record<MeetingState, { variant: "warning" | "destructive" | "success"; icon: LucideIcon; spin?: boolean }> = {
  recording: { variant: "warning", icon: Radio },
  processing: { variant: "warning", icon: Loader2, spin: true },
  done: { variant: "success", icon: CheckCircle2 },
  failed: { variant: "destructive", icon: AlertCircle },
};

function StateBadge({ state }: { state: MeetingState }) {
  const { variant, icon: Icon, spin } = STATE_BADGE[state];
  return (
    <Badge variant={variant}>
      <Icon className={cn("size-3", spin && "animate-spin")} aria-hidden />
      {STATE_LABEL[state]}
    </Badge>
  );
}

function SectionHeading({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
      {children}
    </h2>
  );
}

function Banner({ variant, icon: Icon, children }: { variant: "warning" | "destructive"; icon: LucideIcon; children: ReactNode }) {
  return (
    <Alert variant={variant}>
      <Icon className="size-4" aria-hidden />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function MeetingListRow({ meeting, selected }: { meeting: MeetingListItem; selected: boolean }) {
  return (
    <button
      type="button"
      onClick={() => window.electron.meetings.select(meeting.id)}
      className={cn(
        "w-full border-b px-3 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "bg-accent",
      )}
      aria-current={selected ? "true" : undefined}
    >
      <span className="block font-semibold">{meeting.app}</span>
      <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{formatWhen(meeting.startedAt)}</span>
        <StateBadge state={meeting.state} />
      </span>
    </button>
  );
}

function MeetingDetail({ meeting }: { meeting: Meeting }) {
  const busy = meeting.state === "recording" || meeting.state === "processing";
  const canRegenerate = !busy && meeting.transcript.segments.length > 0;

  return (
    <div className="space-y-6">
      <header className="space-y-3 pb-1">
        <h1 className="text-xl font-semibold tracking-tight">{meeting.app}</h1>
        <p className="text-sm text-muted-foreground">{formatWhen(meeting.startedAt)}</p>
        {!busy && (
          <div className="flex flex-wrap gap-2">
            {canRegenerate && (
              <Button type="button" variant="secondary" size="sm" onClick={() => void window.electron.meetings.regenerate(meeting.id)}>
                <RefreshCw aria-hidden />
                Regenerate Summary
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => window.electron.meetings.export(meeting.id)}>
              <FileDown aria-hidden />
              Export to Markdown…
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={() => void window.electron.meetings.delete(meeting.id)}>
              <Trash2 aria-hidden />
              Delete Meeting
            </Button>
          </div>
        )}
      </header>

      <Separator />

      {meeting.state === "recording" && (
        <Banner variant="warning" icon={Radio}>
          This Meeting is being recorded.
        </Banner>
      )}
      {meeting.state === "processing" && (
        <Banner variant="warning" icon={Loader2}>
          Transcribing and summarising this Meeting…
        </Banner>
      )}
      {meeting.state === "failed" && (
        <Banner variant="destructive" icon={AlertCircle}>
          Processing failed: {meeting.error ?? "unknown error"}
        </Banner>
      )}
      {meeting.state === "done" && meeting.transcript.segments.length === 0 && (
        <p className="text-sm text-muted-foreground">No speech was detected in this Recording.</p>
      )}

      {meeting.participants.length > 0 && (
        <section>
          <SectionHeading icon={Users}>Participants</SectionHeading>
          <div className="space-y-2">
            {meeting.participants.map((p) => (
              <form
                key={p.label}
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const name = (form.elements.namedItem("name") as HTMLInputElement).value;
                  window.electron.meetings.rename({ meetingId: meeting.id, label: p.label, name });
                }}
              >
                <span className="w-24 shrink-0 text-xs text-muted-foreground">{p.label}</span>
                <Input name="name" className="max-w-xs flex-1" defaultValue={p.name ?? ""} placeholder="Name" />
                <Button type="submit" size="sm">Rename</Button>
              </form>
            ))}
          </div>
        </section>
      )}

      {meeting.summary && (
        <section>
          <SectionHeading icon={Sparkles}>Summary</SectionHeading>
          <p className="text-sm leading-relaxed">{meeting.summary.tldr}</p>
          {meeting.summary.participants.map((p) => (
            <div key={p.speaker} className="mt-4">
              <h3 className="font-medium">{p.speaker}</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {p.said.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {meeting.transcript.segments.length > 0 && (
        <section>
          <SectionHeading icon={FileText}>Transcript</SectionHeading>
          <div className="space-y-2">
            {meeting.transcript.segments.map((s, i) => (
              <p key={i} className="border-l-2 border-border pl-3 text-sm leading-relaxed">
                <span className="mr-2 font-mono text-xs text-muted-foreground">{formatClock(s.start)}</span>
                <strong>{s.speaker}</strong> {s.text}
              </p>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function MeetingsApp() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showInDock, setShowInDock] = useState(false);
  const [query, setQuery] = useState("");
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [selected, setSelected] = useState<Meeting | undefined>();

  useEffect(() => {
    const unsubscribe = window.electron.meetings.onState((state) => {
      setSettingsOpen(state.settingsOpen);
      setShowInDock(state.showInDock);
      setQuery(state.query);
      setMeetings(state.meetings);
      setSelected(state.selected);
    });
    window.electron.meetings.ready();
    return unsubscribe;
  }, []);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    window.electron.meetings.search(query);
  };

  return (
    <div className="flex h-screen min-h-0 overflow-hidden">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-muted/40" aria-label="Meetings">
        <form className="relative border-b p-3" onSubmit={onSearch} role="search">
          <Search className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            aria-label="Search meetings"
            className="pl-8"
            placeholder="Search meetings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={() => window.electron.meetings.search(query)}
          />
        </form>
        <ScrollArea className="min-h-0 flex-1">
          {meetings.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
              <Inbox className="size-6" aria-hidden />
              <p>{query.trim() ? "No Meetings match." : "No Meetings yet."}</p>
            </div>
          ) : (
            meetings.map((m) => <MeetingListRow key={m.id} meeting={m} selected={selected?.id === m.id} />)
          )}
        </ScrollArea>
        <div className="border-t p-2">
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => window.electron.meetings.settings(true)}>
            <Settings aria-hidden />
            Settings
          </Button>
        </div>
      </aside>
      <ScrollArea className="min-h-0 flex-1">
        <main className="p-6">
          {selected ? (
            <MeetingDetail meeting={selected} />
          ) : (
            <div className="flex flex-col items-center gap-2 pt-24 text-muted-foreground">
              <MessagesSquare className="size-8" aria-hidden />
              <p>Select a Meeting.</p>
            </div>
          )}
        </main>
      </ScrollArea>
      <SettingsDialog open={settingsOpen} showInDock={showInDock} onOpenChange={(open) => window.electron.meetings.settings(open)} />
    </div>
  );
}
