import { useEffect, useState, type FormEvent } from "react";
import type { Meeting, MeetingListItem, MeetingState } from "../../store/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatClock, formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATE_LABEL: Record<MeetingState, string> = {
  recording: "Recording",
  processing: "Processing",
  done: "Done",
  failed: "Failed",
};

function stateBadgeVariant(state: MeetingState): "warning" | "destructive" | "secondary" {
  if (state === "failed") return "destructive";
  if (state === "recording" || state === "processing") return "warning";
  return "secondary";
}

function MeetingListRow({ meeting, selected }: { meeting: MeetingListItem; selected: boolean }) {
  return (
    <button
      type="button"
      onClick={() => window.electron.meetings.select(meeting.id)}
      className={cn(
        "w-full border-b px-3 py-2.5 text-left transition-colors hover:bg-accent/60",
        selected && "bg-accent",
      )}
    >
      <span className="block font-semibold">{meeting.app}</span>
      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{formatWhen(meeting.startedAt)}</span>
        <Badge variant={stateBadgeVariant(meeting.state)}>{STATE_LABEL[meeting.state]}</Badge>
      </span>
    </button>
  );
}

function MeetingDetail({ meeting }: { meeting: Meeting }) {
  const busy = meeting.state === "recording" || meeting.state === "processing";
  const canRegenerate = !busy && meeting.transcript.segments.length > 0;

  return (
    <div className="space-y-6">
      <header className="space-y-3 border-b pb-5">
        <h1 className="text-xl font-semibold tracking-tight">{meeting.app}</h1>
        <p className="text-sm text-muted-foreground">{formatWhen(meeting.startedAt)}</p>
        {!busy && (
          <div className="flex flex-wrap gap-2">
            {canRegenerate && (
              <Button type="button" variant="secondary" size="sm" onClick={() => void window.electron.meetings.regenerate(meeting.id)}>
                Regenerate Summary
              </Button>
            )}
            <Button type="button" variant="destructive" size="sm" onClick={() => void window.electron.meetings.delete(meeting.id)}>
              Delete Meeting
            </Button>
          </div>
        )}
        <Button type="button" variant="link" className="h-auto p-0" onClick={() => window.electron.meetings.export(meeting.id)}>
          Export to Markdown…
        </Button>
      </header>

      {meeting.state === "recording" && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">This Meeting is being recorded.</p>
      )}
      {meeting.state === "processing" && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Transcribing and summarising this Meeting…
        </p>
      )}
      {meeting.state === "failed" && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Processing failed: {meeting.error ?? "unknown error"}
        </p>
      )}
      {meeting.state === "done" && meeting.transcript.segments.length === 0 && (
        <p className="text-sm text-muted-foreground">No speech was detected in this Recording.</p>
      )}

      {meeting.participants.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Participants</h2>
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
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</h2>
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
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Transcript</h2>
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
  const [query, setQuery] = useState("");
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [selected, setSelected] = useState<Meeting | undefined>();

  useEffect(() => {
    const unsubscribe = window.electron.meetings.onState((state) => {
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
    <div className="flex h-screen min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-muted/40">
        <form className="border-b p-3" onSubmit={onSearch}>
          <Input
            type="search"
            placeholder="Search meetings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={() => window.electron.meetings.search(query)}
          />
        </form>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {meetings.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              {query.trim() ? "No Meetings match." : "No Meetings yet."}
            </p>
          ) : (
            meetings.map((m) => <MeetingListRow key={m.id} meeting={m} selected={selected?.id === m.id} />)
          )}
        </div>
      </aside>
      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        {selected ? <MeetingDetail meeting={selected} /> : <p className="text-center text-muted-foreground">Select a Meeting.</p>}
      </main>
    </div>
  );
}
