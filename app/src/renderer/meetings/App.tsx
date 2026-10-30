import { toast } from "sonner";
import { useJobToasts } from "./job-toasts";
import type { MeetingsViewState } from "../../shared/meetings-view-state";
import { MeetingDetail } from "./MeetingDetail";
import { Sidebar } from "./Sidebar";
import { restartForUpdate } from "./update-actions";
import { MessagesSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Meeting, MeetingListItem } from "../../store/store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Toaster } from "@/components/ui/sonner";
import { SettingsPage, type SettingsSection } from "../settings/SettingsPage";

export function MeetingsApp() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showInDock, setShowInDock] = useState(true);
  const [keepAudio, setKeepAudio] = useState(false);
  const [checkForUpdates, setCheckForUpdates] = useState(true);
  const [section, setSection] = useState<SettingsSection>("General");
  const [recording, setRecording] = useState<MeetingsViewState["recording"]>();
  const [update, setUpdate] = useState<NonNullable<MeetingsViewState["update"]>>({ status: "idle" });
  const [appVersion, setAppVersion] = useState<string>();
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
      setRecording(state.recording);
      setUpdate(state.update ?? { status: "idle" });
      setAppVersion(state.appVersion);
      setJobs(state.jobs);
      setSettingsOpen(state.settingsOpen);
      setShowInDock(state.showInDock);
      setKeepAudio(state.keepAudio ?? false);
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
              void restartForUpdate();
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

  const openSettings = (next?: SettingsSection) => {
    if (next) setSection(next);
    window.electron.meetings.settings(true);
  };

  return (
    <div className="flex h-screen min-h-0 overflow-hidden">
      <Sidebar
        meetings={meetings}
        selectedId={selected?.id}
        settingsOpen={settingsOpen}
        query={query}
        onQuery={setQuery}
        onSearch={() => window.electron.meetings.search(query)}
        onSelect={(id) => {
          if (settingsOpen) window.electron.meetings.settings(false);
          window.electron.meetings.select(id);
        }}
        onSettings={() => openSettings(update.status !== "idle" ? "Updates" : undefined)}
        recording={recording}
        update={update}
      />
      {settingsOpen ? (
        <main className="min-w-0 flex-1">
          <SettingsPage
            section={section}
            onSectionChange={setSection}
            onBack={() => window.electron.meetings.settings(false)}
            showInDock={showInDock}
            keepAudio={keepAudio}
            checkForUpdates={checkForUpdates}
            update={update}
            appVersion={appVersion}
          />
        </main>
      ) : (
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <main className="min-w-0">
            {selected ? (
              <MeetingDetail key={`${selected.id}:${chat?.revision ?? "legacy"}`} meeting={selected} chat={chat} isCurrent={() => selection.current.id === selected.id && selection.current.revision === chat?.revision} />
            ) : (
              <div className="flex flex-col items-center gap-2 pt-24 text-muted-foreground">
                <MessagesSquare className="size-8" aria-hidden />
                <p>Select a Meeting.</p>
              </div>
            )}
          </main>
        </ScrollArea>
      )}
      <Toaster position="bottom-right" />
    </div>
  );
}
