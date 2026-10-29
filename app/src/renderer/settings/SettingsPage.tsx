import { ArrowLeft, Bell, CheckCircle2, Cpu, Download, ExternalLink, Loader2, RefreshCw, ShieldCheck, SlidersHorizontal, XCircle, AlertCircle, type LucideIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { UpdateState } from "../../core/updater";
import type { Step } from "../../setup/setup";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { PERMISSIONS, type PermissionCopy, type PermissionStep } from "@/lib/permissions";
import { useSetup } from "@/lib/use-setup";
import { cn } from "@/lib/utils";
import { restartForUpdate } from "../meetings/update-actions";

export const SECTIONS = ["General", "Permissions", "Models", "Updates"] as const;
export type SettingsSection = (typeof SECTIONS)[number];

const SECTION_ICON: Record<SettingsSection, LucideIcon> = { General: SlidersHorizontal, Permissions: ShieldCheck, Models: Cpu, Updates: Bell };

const STATUS_ICON: Partial<Record<NonNullable<BadgeProps["variant"]>, LucideIcon>> = {
  success: CheckCircle2,
  warning: Loader2,
  destructive: XCircle,
};

function Status({ label, variant }: { label: string; variant: BadgeProps["variant"] }) {
  const Icon = variant ? STATUS_ICON[variant] : undefined;
  return (
    <Badge variant={variant}>
      {Icon && <Icon className={variant === "warning" ? "size-3 animate-spin" : "size-3"} aria-hidden />}
      {label}
    </Badge>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" className="mt-2">
      <AlertCircle className="size-4" aria-hidden />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** One setting: a title and what it does on the left, its control on the right. */
function SettingRow({ title, htmlFor, description, children, below, stacked }: { title: string; htmlFor?: string; description: ReactNode; children?: ReactNode; below?: ReactNode; stacked?: boolean }) {
  return (
    <div className="py-4">
      <div className={cn("flex gap-x-6 gap-y-3", stacked ? "flex-col" : "items-start justify-between")}>
        <div className="min-w-0 space-y-1">
          {htmlFor ? <Label htmlFor={htmlFor} className="text-sm font-medium">{title}</Label> : <h3 className="text-sm font-medium">{title}</h3>}
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {children && <div className="shrink-0">{children}</div>}
      </div>
      {below}
    </div>
  );
}

function NameForm({ userName }: { userName: string }) {
  const [name, setName] = useState(userName);
  const changed = name.trim() !== userName;
  const save = (e: FormEvent) => {
    e.preventDefault();
    window.electron.setup.setUserName(name);
    toast.success(name.trim() ? "Name saved" : "Name cleared");
  };
  return (
    <form onSubmit={save} className="flex items-center gap-2">
      <Input id="user-name" aria-label="Name" autoComplete="name" maxLength={100} className="w-56" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
      <Button type="submit" disabled={!changed}>
        Save
      </Button>
    </form>
  );
}

function General({ showInDock, name, userName }: { showInDock: boolean; name: string; userName: string }) {
  return (
    <div className="divide-y">
      <SettingRow stacked title="Your name" htmlFor="user-name" description={<>Shown in place of &ldquo;You&rdquo; in transcripts, summaries and exports, in every Meeting. It is kept on this Mac only.</>}>
        {/* Keyed on the saved name so the field follows a change made elsewhere. */}
        <NameForm key={userName} userName={userName} />
      </SettingRow>
      <SettingRow title="Show in Dock" htmlFor="show-in-dock" description={`${name} always has its menu bar icon. With this on, it also shows in the Dock: click the icon to open ${name}, and minimised windows go there.`}>
        <Switch id="show-in-dock" checked={showInDock} onCheckedChange={(checked) => window.electron.meetings.setShowInDock(checked)} />
      </SettingRow>
    </div>
  );
}

function PermissionRow({ copy, step, name }: { copy: PermissionCopy; step: PermissionStep; name: string }) {
  const act = window.electron.setup.act;
  const missing = step.status === "todo" || step.status === "problem";
  return (
    <SettingRow
      title={copy.title}
      description={copy.purpose(name)}
      below={
        <>
          {step.status === "problem" && step.message && <Problem>{step.message}</Problem>}
          {missing && (
            <Button type="button" variant="link" size="sm" className="mt-1 h-auto p-0" aria-label={`Open System Settings for ${copy.title.toLowerCase()}`} onClick={() => act(copy.settingsAction)}>
              <ExternalLink aria-hidden />
              Open System Settings
            </Button>
          )}
        </>
      }
    >
      {step.status === "done" && <Status label="Allowed" variant="success" />}
      {step.status === "working" && <Status label="Waiting for macOS…" variant="warning" />}
      {missing && (
        <div className="flex items-center gap-2">
          <Status label="Not allowed" variant="destructive" />
          <Button type="button" size="sm" onClick={() => act(copy.action)}>
            {step.status === "problem" && <RefreshCw aria-hidden />}
            {step.status === "problem" ? "Check again" : "Allow"}
          </Button>
        </div>
      )}
    </SettingRow>
  );
}

function Permissions({ state, name }: { state: { microphone: PermissionStep; systemAudio: PermissionStep }; name: string }) {
  return (
    <>
      <p className="text-sm text-muted-foreground">macOS remembers your answer, so each permission is asked for once.</p>
      <div className="divide-y">
        <PermissionRow copy={PERMISSIONS.microphone} step={state.microphone} name={name} />
        <PermissionRow copy={PERMISSIONS.systemAudio} step={state.systemAudio} name={name} />
      </div>
    </>
  );
}

function Models({ models, ollama, name }: { models: Step & { fraction: number }; ollama: Step; name: string }) {
  const percent = Math.round(models.fraction * 100);
  return (
    <div className="divide-y">
      <SettingRow
        title="Speech and speaker models"
        description={`${name} turns speech into text and tells speakers apart on your Mac, with no cloud service. The models need a one-time download.`}
        below={
          <div className="space-y-3 pt-3">
            {models.status === "working" && (
              <div className="space-y-1">
                <Progress value={percent} aria-label="Model download" />
                <p className="text-sm text-muted-foreground">{models.fraction >= 1 ? "Preparing the models…" : `${percent}% downloaded`}</p>
              </div>
            )}
            {models.status === "problem" && models.message && <Problem>{models.message}</Problem>}
            {(models.status === "todo" || models.status === "problem") && (
              <Button type="button" onClick={() => window.electron.setup.act("models")}>
                {models.status === "problem" ? <RefreshCw aria-hidden /> : <Download aria-hidden />}
                {models.status === "problem" ? "Try again" : "Download models"}
              </Button>
            )}
          </div>
        }
      >
        {models.status === "done" && <Status label="Downloaded" variant="success" />}
        {models.status === "working" && <Status label="Downloading…" variant="warning" />}
        {models.status === "problem" && <Status label="Failed" variant="destructive" />}
        {models.status === "todo" && <Status label="Not downloaded" variant="secondary" />}
      </SettingRow>
      <SettingRow
        title="Summaries"
        description="Summaries are written by a model running in Ollama on your Mac. Ollama must be running with the model pulled. You can record without it and summarise later."
        below={
          <div className="space-y-3 pt-3">
            {ollama.status === "problem" && ollama.message && <Problem>{ollama.message}</Problem>}
            {ollama.status !== "working" && (
              <Button type="button" variant={ollama.status === "done" ? "outline" : "default"} onClick={() => window.electron.setup.act("ollama")}>
                <RefreshCw aria-hidden />
                {ollama.status === "todo" ? "Check Ollama" : "Check again"}
              </Button>
            )}
          </div>
        }
      >
        {ollama.status === "done" && <Status label="Ready" variant="success" />}
        {ollama.status === "working" && <Status label="Checking…" variant="warning" />}
        {ollama.status === "problem" && <Status label="Not ready" variant="destructive" />}
      </SettingRow>
    </div>
  );
}

function Updates({ checkForUpdates, update, appVersion, name }: { checkForUpdates: boolean; update: UpdateState; appVersion?: string; name: string }) {
  return (
    <div className="divide-y">
      <SettingRow
        title="Version"
        description={
          update.status === "ready"
            ? `Version ${update.version} is downloaded. Restart to update; it is also installed the next time ${name} quits.`
            : update.status === "downloading"
              ? `Downloading version ${update.version} in the background.`
              : update.status === "failed"
                ? `Version ${update.version} could not be installed. You can download it from the release page.`
                : `${name} ${appVersion ?? ""}`.trim()
        }
      >
        {update.status === "ready" && (
          <Button type="button" size="sm" onClick={() => void restartForUpdate()}>
            Restart to update
          </Button>
        )}
        {update.status === "downloading" && <Status label={`Downloading… ${update.percent}%`} variant="warning" />}
        {update.status === "failed" && (
          <Button type="button" size="sm" variant="outline" onClick={() => window.electron.meetings.openRelease()}>
            View release
          </Button>
        )}
        {update.status === "idle" && <Status label={checkForUpdates ? "No update waiting" : "Checks are off"} variant="secondary" />}
      </SettingRow>
      <SettingRow
        title="Check for updates"
        htmlFor="check-for-updates"
        description={`When ${name} starts, it asks GitHub whether a newer release is out and downloads it in the background. You choose when to restart into it, and not while a Recording or a Meeting's processing is under way. It sends nothing about you or your Meetings.`}
      >
        <Switch id="check-for-updates" checked={checkForUpdates} onCheckedChange={(checked) => window.electron.meetings.setCheckForUpdates(checked)} />
      </SettingRow>
    </div>
  );
}

/**
 * Settings, as a page in the main area: a list of sections on the left and one section at a time on the right. Back (or Esc)
 * returns to the Meeting that was open.
 */
export function SettingsPage({
  section,
  onSectionChange,
  onBack,
  showInDock = true,
  checkForUpdates = true,
  update = { status: "idle" },
  appVersion,
}: {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onBack: () => void;
  showInDock?: boolean;
  checkForUpdates?: boolean;
  update?: UpdateState;
  appVersion?: string;
}) {
  const view = useSetup();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <section aria-label="Settings" className="flex h-full min-h-0">
      <nav aria-label="Settings sections" className="w-40 shrink-0 space-y-1 border-r p-3">
        <Button type="button" variant="ghost" size="sm" className="-ml-2 mb-3 text-muted-foreground" onClick={onBack}>
          <ArrowLeft aria-hidden />
          Meetings
        </Button>
        {SECTIONS.map((id) => {
          const Icon = SECTION_ICON[id];
          return (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => onSectionChange(id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                section === id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {id}
              {id === "Updates" && update.status === "ready" && <span className="ml-auto size-2 rounded-full bg-primary" aria-label="An update is ready" />}
            </button>
          );
        })}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
        <h1 className="mb-2 text-xl font-semibold tracking-tight">{section}</h1>
        {view && (
          <>
            {section === "General" && <General showInDock={showInDock} name={view.name} userName={view.userName} />}
            {section === "Permissions" && <Permissions state={view.state} name={view.name} />}
            {section === "Models" && <Models models={view.state.models} ollama={view.state.ollama} name={view.name} />}
            {section === "Updates" && <Updates checkForUpdates={checkForUpdates} update={update} appVersion={appVersion} name={view.name} />}
          </>
        )}
      </div>
    </section>
  );
}
