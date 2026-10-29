import { toast } from "sonner";
import { useJobToasts } from "./job-toasts";
import type { MeetingsViewState } from "../../shared/meetings-view-state";
import { MeetingDetail } from "./MeetingDetail";
import { AlertCircle, CheckCircle2, Hourglass, Inbox, MessagesSquare, Radio, Search, Settings, UserRound, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Meeting, MeetingListItem, MeetingState } from "../../store/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Toaster } from "@/components/ui/sonner";
import { formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ProfilePage } from "../profile/ProfilePage";
import { SettingsDialog } from "../settings/SettingsDialog";

const STATE_LABEL: Record<MeetingState, string> = {
  recording: "Recording",
  processing: "Processing",
  done: "Done",
  failed: "Failed",
};

// Work in progress is shown as toasts (see job-toasts.tsx), so nothing in the list spins.
const STATE_BADGE: Record<MeetingState, { variant: "warning" | "destructive" | "success"; icon: LucideIcon }> = {
  recording: { variant: "warning", icon: Radio },
  processing: { variant: "warning", icon: Hourglass },
  done: { variant: "success", icon: CheckCircle2 },
  failed: { variant: "destructive", icon: AlertCircle },
};

function StateBadge({ state }: { state: MeetingState }) {
  const { variant, icon: Icon } = STATE_BADGE[state];
  return (
    <Badge variant={variant}>
      <Icon className="size-3" aria-hidden />
      {STATE_LABEL[state]}
    </Badge>
  );
}

function MeetingListRow({ meeting, selected, onSelect }: { meeting: MeetingListItem; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        onSelect();
        window.electron.meetings.select(meeting.id);
      }}
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
  const [showInDock, setShowInDock] = useState(true);
  const [checkForUpdates, setCheckForUpdates] = useState(true);
  // Profile is a page of its own in the main area; picking a Meeting brings the Meetings back.
  const [page, setPage] = useState<"meetings" | "profile">("meetings");
  const [query, setQuery] = useState("");
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [selected, setSelected] = useState<Meeting | undefined>();
  const [jobs, setJobs] = useState<MeetingsViewState["jobs"]>();
  const [chat, setChat] = useState<MeetingsViewState["chat"]>();
  const selection = useRef<{ id?: number; revision?: string }>({});
  useJobToasts(jobs, meetings);

  useEffect(() => {
    const unsubscribe = window.electron.meetings.onState((state) => {
      selection.current = { id: state.selected?.id, revision: state.chat?.revision };
      setChat(state.chat);
      setJobs(state.jobs);
      setSettingsOpen(state.settingsOpen);
      setShowInDock(state.showInDock);
      setCheckForUpdates(state.checkForUpdates);
      setQuery(state.query);
      setMeetings(state.meetings);
      setSelected(state.selected);
    });
    // One toast follows an update from downloading to ready (or failed) and stays on screen until the person closes it. Restart
    // keeps it open when the app refuses (a Recording or AI work is going on), so it can be pressed again later.
    const unsubscribeUpdate = window.electron.meetings.onUpdate((update) => {
      const id = "update";
      if (update.status === "downloading") {
        toast.loading(`Downloading version ${update.version}… ${update.percent}%`, { id, duration: Infinity });
      } else if (update.status === "ready") {
        toast(`Version ${update.version} is ready. Restart to update`, {
          id,
          duration: Infinity,
          closeButton: true,
          action: {
            label: "Restart",
            onClick: (event) => {
              event.preventDefault();
              void window.electron.meetings.restartForUpdate().then((result) => {
                if (!result.ok) toast.error(result.reason, { id: "update-refused", duration: 8000 });
              });
            },
          },
        });
      } else {
        toast.error(`Could not update to version ${update.version}`, {
          id,
          description: "You can still download it from the release page.",
          duration: Infinity,
          closeButton: true,
          action: { label: "View release", onClick: () => window.electron.meetings.openRelease() },
        });
      }
    });
    window.electron.meetings.ready();
    return () => {
      unsubscribe();
      unsubscribeUpdate();
    };
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
            meetings.map((m) => <MeetingListRow key={m.id} meeting={m} selected={page === "meetings" && selected?.id === m.id} onSelect={() => setPage("meetings")} />)
          )}
        </ScrollArea>
        <div className="space-y-1 border-t p-2">
          <Button type="button" variant={page === "profile" ? "secondary" : "ghost"} size="sm" className="w-full justify-start" aria-current={page === "profile" ? "page" : undefined} onClick={() => setPage("profile")}>
            <UserRound aria-hidden />
            Profile
          </Button>
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => window.electron.meetings.settings(true)}>
            <Settings aria-hidden />
            Settings
          </Button>
        </div>
      </aside>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <main className="min-w-0 p-4 sm:p-6">
          {page === "profile" ? (
            <ProfilePage />
          ) : selected ? (
            <MeetingDetail key={`${selected.id}:${chat?.revision ?? "legacy"}`} meeting={selected} chat={chat} isCurrent={() => selection.current.id === selected.id && selection.current.revision === chat?.revision} />
          ) : (
            <div className="flex flex-col items-center gap-2 pt-24 text-muted-foreground">
              <MessagesSquare className="size-8" aria-hidden />
              <p>Select a Meeting.</p>
            </div>
          )}
        </main>
      </ScrollArea>
      <Toaster position="bottom-right" />
      <SettingsDialog open={settingsOpen} showInDock={showInDock} checkForUpdates={checkForUpdates} onOpenChange={(open) => window.electron.meetings.settings(open)} />
    </div>
  );
}
