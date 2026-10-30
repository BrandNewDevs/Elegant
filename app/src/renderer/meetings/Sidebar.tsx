import { Download, Inbox, Search, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import type { UpdateState } from "../../core/updater";
import type { ActiveRecording } from "../../core/app-core";
import { formatElapsed } from "../../core/elapsed";
import type { MeetingListItem, MeetingState } from "../../store/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatTime, groupByDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import { restartForUpdate } from "./update-actions";

const STATE_DOT: Record<MeetingState, { label: string; className: string }> = {
  recording: { label: "Recording", className: "animate-pulse bg-destructive" },
  processing: { label: "Processing", className: "bg-amber-500" },
  done: { label: "Done", className: "bg-muted-foreground/40" },
  failed: { label: "Failed", className: "bg-destructive" },
};

function MeetingRow({ meeting, selected, onSelect }: { meeting: MeetingListItem; selected: boolean; onSelect: () => void }) {
  const { label, className } = STATE_DOT[meeting.state];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className={cn("size-2 shrink-0 rounded-full", className)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{meeting.app}</span>
        <span className="block text-xs text-muted-foreground">
          {formatTime(meeting.startedAt)}
          <span className="sr-only">, {label}</span>
        </span>
      </span>
    </button>
  );
}

function RecordingStrip({ recording }: { recording: ActiveRecording }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs">
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-medium">
        Recording {recording.app} · {formatElapsed(recording.startedAt)}
      </span>
      <button type="button" onClick={() => window.electron.meetings.stopRecording()} className="font-medium text-destructive hover:underline">
        Stop
      </button>
    </div>
  );
}

function UpdateStrip({ update, onOpenSettings }: { update: UpdateState; onOpenSettings: () => void }) {
  if (update.status === "idle") return null;
  const text =
    update.status === "ready" ? `Version ${update.version} is ready` : update.status === "downloading" ? `Downloading ${update.version}… ${update.percent}%` : `Could not update to ${update.version}`;
  return (
    <div className="flex items-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-xs">
      <Download className="size-3.5 shrink-0 text-primary" aria-hidden />
      <button type="button" onClick={onOpenSettings} className="min-w-0 flex-1 truncate text-left font-medium hover:underline">
        {text}
      </button>
      {update.status === "ready" && (
        <button type="button" onClick={() => void restartForUpdate()} className="font-medium text-primary hover:underline">
          Restart
        </button>
      )}
      {update.status === "failed" && (
        <button type="button" onClick={() => window.electron.meetings.openRelease()} className="font-medium text-primary hover:underline">
          View release
        </button>
      )}
    </div>
  );
}

/** The Meetings by day, what is happening now (a Recording, an update), and the way into Settings. */
export function Sidebar({
  meetings,
  selectedId,
  settingsOpen,
  query,
  onQuery,
  onSearch,
  onSelect,
  onSettings,
  recording,
  update,
}: {
  meetings: MeetingListItem[];
  selectedId: number | undefined;
  settingsOpen: boolean;
  query: string;
  onQuery: (query: string) => void;
  onSearch: () => void;
  onSelect: (id: number) => void;
  onSettings: () => void;
  recording: ActiveRecording | undefined;
  update: UpdateState;
}) {
  const searching = query.trim() !== "";
  // A search result is ordered by relevance, so it is not split by day.
  const groups = searching ? [{ day: "", items: meetings }] : groupByDay(meetings);
  const busy = recording !== undefined || update.status !== "idle";
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/40 md:w-64" aria-label="Meetings">
      <form
        className="relative p-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch();
        }}
        role="search"
      >
        <Search className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input type="search" aria-label="Search meetings" className="pl-8" placeholder="Search meetings" value={query} onChange={(e) => onQuery(e.target.value)} onBlur={onSearch} />
      </form>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        {meetings.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Inbox className="size-6" aria-hidden />
            <p>{searching ? "No Meetings match." : "No Meetings yet."}</p>
          </div>
        ) : (
          <div className="px-2 pb-2">
            {groups.map(({ day, items }) => (
              <section key={day} aria-label={day || "Search results"} className="mb-2">
                {day && <h2 className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{day}</h2>}
                {items.map((m) => (
                  <MeetingRow key={m.id} meeting={m} selected={selectedId === m.id} onSelect={() => onSelect(m.id)} />
                ))}
              </section>
            ))}
          </div>
        )}
      </ScrollArea>
      {busy && (
        <div className="space-y-1.5 border-t p-2">
          {recording && <RecordingStrip recording={recording} />}
          <UpdateStrip update={update} onOpenSettings={onSettings} />
        </div>
      )}
      <div className="border-t p-2">
        <Button type="button" variant={settingsOpen ? "secondary" : "ghost"} size="sm" className="w-full justify-start" aria-current={settingsOpen ? "page" : undefined} onClick={onSettings}>
          <Settings aria-hidden />
          Settings
        </Button>
      </div>
    </aside>
  );
}
