import { JobStatus } from "./JobStatus";
import type { MeetingsViewState } from "../../shared/meetings-view-state";
import { MeetingDetail } from "./MeetingDetail";
import { AlertCircle, CheckCircle2, Inbox, Loader2, MessagesSquare, Radio, Search, Settings, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Meeting, MeetingListItem, MeetingState } from "../../store/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatWhen } from "@/lib/format";
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

export function MeetingsApp() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showInDock, setShowInDock] = useState(false);
  const [query, setQuery] = useState("");
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [selected, setSelected] = useState<Meeting | undefined>();
  const [jobs, setJobs] = useState<MeetingsViewState["jobs"]>();
  const [chat, setChat] = useState<MeetingsViewState["chat"]>();
  const selection = useRef<{ id?: number; revision?: string }>({});

  useEffect(() => {
    const unsubscribe = window.electron.meetings.onState((state) => {
      selection.current = { id: state.selected?.id, revision: state.chat?.revision };
      setChat(state.chat);
      setJobs(state.jobs);
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
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/40 md:w-72" aria-label="Meetings">
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
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          {meetings.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
              <Inbox className="size-6" aria-hidden />
              <p>{query.trim() ? "No Meetings match." : "No Meetings yet."}</p>
            </div>
          ) : (
            meetings.map((m) => <MeetingListRow key={m.id} meeting={m} selected={selected?.id === m.id} />)
          )}
        </ScrollArea>
        {jobs?.length ? <div className="p-2"><JobStatus jobs={jobs} /></div> : null}
        <div className="border-t p-2">
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => window.electron.meetings.settings(true)}>
            <Settings aria-hidden />
            Settings
          </Button>
        </div>
      </aside>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <main className="min-w-0 p-4 sm:p-6">
          {selected ? (
            <MeetingDetail key={`${selected.id}:${chat?.revision ?? "legacy"}`} meeting={selected} chat={chat} jobs={jobs} isCurrent={() => selection.current.id === selected.id && selection.current.revision === chat?.revision} />
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
