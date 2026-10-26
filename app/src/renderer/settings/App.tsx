import type { ReactNode } from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { PERMISSIONS, type PermissionCopy, type PermissionStep } from "@/lib/permissions";
import { useSetup } from "@/lib/use-setup";
import type { Step } from "../../setup/setup";

function Status({ label, variant }: { label: string; variant: BadgeProps["variant"] }) {
  return <Badge variant={variant}>{label}</Badge>;
}

function Problem({ children }: { children: ReactNode }) {
  return <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{children}</p>;
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
              {step.status === "problem" ? "Check again" : "Allow"}
            </Button>
          </div>
        )}
      </div>
      {step.status === "problem" && (
        <>
          {step.message && <Problem>{step.message}</Problem>}
          <Button type="button" variant="link" size="sm" className="mt-1 h-auto p-0" onClick={() => act(copy.settingsAction)}>
            Open System Settings
          </Button>
        </>
      )}
    </div>
  );
}

function ModelsCard({ models, name }: { models: Step & { fraction: number }; name: string }) {
  const percent = Math.round(models.fraction * 100);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Speech and speaker models</CardTitle>
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
          <CardTitle className="text-base">Summaries</CardTitle>
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
            {ollama.status === "todo" ? "Check Ollama" : "Check again"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function SettingsApp() {
  const view = useSetup();
  if (!view) return null;
  const { name, state } = view;

  return (
    <main className="mx-auto max-w-xl space-y-5 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-base">Permissions</CardTitle>
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
    </main>
  );
}
