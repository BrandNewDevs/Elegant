import { AlertCircle, CheckCircle2, Cpu, Dock, UserRound, Download, ExternalLink, Loader2, RefreshCw, Settings, ShieldCheck, Sparkles, XCircle, type LucideIcon } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { PERMISSIONS, type PermissionCopy, type PermissionStep } from "@/lib/permissions";
import { useSetup } from "@/lib/use-setup";
import type { Step } from "../../setup/setup";

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

function CardHeading({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <CardTitle className="flex items-center gap-2 text-base">
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      {children}
    </CardTitle>
  );
}

function PermissionRow({ copy, step, name }: { copy: PermissionCopy; step: PermissionStep; name: string }) {
  const act = window.electron.setup.act;
  const Icon = copy.icon;
  return (
    <div className="py-3">
      <div className="flex items-center gap-3">
        <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{copy.title}</h3>
          <p className="text-sm text-muted-foreground">{copy.purpose(name)}</p>
        </div>
        {step.status === "done" && <Status label="Allowed" variant="success" />}
        {step.status === "working" && <Status label="Waiting for macOS…" variant="warning" />}
        {(step.status === "todo" || step.status === "problem") && (
          <div className="flex items-center gap-2">
            <Status label="Not allowed" variant="destructive" />
            <Button type="button" size="sm" onClick={() => act(copy.action)}>
              {step.status === "problem" && <RefreshCw aria-hidden />}
              {step.status === "problem" ? "Check again" : "Allow"}
            </Button>
          </div>
        )}
      </div>
      {step.status === "problem" && (
        <>
          {step.message && <Problem>{step.message}</Problem>}
          <Button type="button" variant="link" size="sm" className="mt-1 h-auto p-0" onClick={() => act(copy.settingsAction)}>
            <ExternalLink aria-hidden />
            Open System Settings
          </Button>
        </>
      )}
    </div>
  );
}

function NameCard({ userName }: { userName: string }) {
  const [name, setName] = useState(userName);
  const changed = name.trim() !== userName;
  const save = (e: FormEvent) => {
    e.preventDefault();
    window.electron.setup.setUserName(name);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardHeading icon={UserRound}>Your name</CardHeading>
        <CardDescription>Shown in place of &ldquo;You&rdquo; in transcripts, summaries and exports, in every Meeting.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex items-end gap-2">
          <div className="flex-1 space-y-2">
            <Label htmlFor="user-name">Name</Label>
            <Input id="user-name" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
          </div>
          <Button type="submit" disabled={!changed}>
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function DockCard({ showInDock, name }: { showInDock: boolean; name: string }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0 pb-6">
        <div className="space-y-1.5">
          <CardHeading icon={Dock}>
            <Label htmlFor="show-in-dock" className="text-base">
              Show in Dock
            </Label>
          </CardHeading>
          <CardDescription>
            {name} always has its menu bar icon. With this on, it also shows in the Dock: click the icon to open {name}, and minimised windows go there.
          </CardDescription>
        </div>
        <Switch id="show-in-dock" checked={showInDock} onCheckedChange={(checked) => window.electron.meetings.setShowInDock(checked)} />
      </CardHeader>
    </Card>
  );
}

function ModelsCard({ models, name }: { models: Step & { fraction: number }; name: string }) {
  const percent = Math.round(models.fraction * 100);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1.5">
          <CardHeading icon={Cpu}>Speech and speaker models</CardHeading>
          <CardDescription>
            {name} turns speech into text and tells speakers apart on your Mac, with no cloud service. The models need a one-time download.
          </CardDescription>
        </div>
        {models.status === "done" && <Status label="Downloaded" variant="success" />}
        {models.status === "working" && <Status label="Downloading…" variant="warning" />}
        {models.status === "problem" && <Status label="Failed" variant="destructive" />}
        {models.status === "todo" && <Status label="Not downloaded" variant="secondary" />}
      </CardHeader>
      <CardContent className="space-y-3">
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
      </CardContent>
    </Card>
  );
}

function SummariesCard({ ollama }: { ollama: Step }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1.5">
          <CardHeading icon={Sparkles}>Summaries</CardHeading>
          <CardDescription>
            Summaries are written by a model running in Ollama on your Mac. Ollama must be running with the model pulled. You can record without it and
            summarise later.
          </CardDescription>
        </div>
        {ollama.status === "done" && <Status label="Ready" variant="success" />}
        {ollama.status === "working" && <Status label="Checking…" variant="warning" />}
        {ollama.status === "problem" && <Status label="Not ready" variant="destructive" />}
      </CardHeader>
      <CardContent className="space-y-3">
        {ollama.status === "problem" && ollama.message && <Problem>{ollama.message}</Problem>}
        {ollama.status !== "working" && (
          <Button type="button" variant={ollama.status === "done" ? "outline" : "default"} onClick={() => window.electron.setup.act("ollama")}>
            <RefreshCw aria-hidden />
            {ollama.status === "todo" ? "Check Ollama" : "Check again"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function SettingsContent({ showInDock }: { showInDock: boolean }) {
  const view = useSetup();
  if (!view) return null;
  const { name, state } = view;

  return (
    <div className="space-y-5">
      <NameCard key={view.userName} userName={view.userName} />
      <DockCard showInDock={showInDock} name={name} />
      <Card>
        <CardHeader className="pb-1">
          <CardHeading icon={ShieldCheck}>Permissions</CardHeading>
          <CardDescription>macOS remembers your answer, so each permission is asked for once.</CardDescription>
        </CardHeader>
        <CardContent>
          <PermissionRow copy={PERMISSIONS.microphone} step={state.microphone} name={name} />
          <Separator />
          <PermissionRow copy={PERMISSIONS.systemAudio} step={state.systemAudio} name={name} />
        </CardContent>
      </Card>
      <ModelsCard models={state.models} name={name} />
      <SummariesCard ollama={state.ollama} />
    </div>
  );
}

/** Settings, as a dialog over the main window: your name, Show in Dock, the permissions, the model download and the Ollama check. */
export function SettingsDialog({
  open,
  onOpenChange,
  showInDock = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showInDock?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[88vh] max-w-xl flex-col gap-0 overflow-hidden p-0"
        // The content below arrives a moment after the dialog opens, so by default focus would land on the close button, the
        // only thing there yet. Put it on the dialog itself instead: Esc and Tab work, and nothing looks focused.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        {/* The frame does not scroll, so the header and the close button stay put; only the body below does. */}
        <DialogHeader className="border-b p-6 pr-12">
          <DialogTitle className="flex items-center gap-2.5 text-xl">
            <Settings className="size-5 text-muted-foreground" aria-hidden />
            Settings
          </DialogTitle>
          <DialogDescription>Your name, the Dock, the permissions, and what summaries need.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <SettingsContent showInDock={showInDock} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
