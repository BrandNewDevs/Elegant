import { useEffect, useState, type ReactNode } from "react";
import type { SetupViewState } from "../../shared/setup-view-state";
import type { Step } from "../../setup/first-run-setup";
import type { SetupAction } from "../../shared/setup-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

function StepActions({
  step,
  startLabel,
  againLabel,
  action,
  settingsAction,
}: {
  step: Step;
  startLabel: string;
  againLabel: string;
  action: SetupAction;
  settingsAction?: SetupAction;
}) {
  switch (step.status) {
    case "todo":
      return (
        <Button type="button" onClick={() => window.electron.setup.act(action)}>
          {startLabel}
        </Button>
      );
    case "working":
      return <span className="text-sm font-medium text-amber-700">Working…</span>;
    case "done":
      return <span className="text-sm font-medium text-green-700">✓ Done</span>;
    case "problem":
      return (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => window.electron.setup.act(action)}>{againLabel}</Button>
          {settingsAction && (
            <Button type="button" variant="link" className="h-auto p-0" onClick={() => window.electron.setup.act(settingsAction)}>
              Open System Settings
            </Button>
          )}
        </div>
      );
  }
}

function SetupCard({
  title,
  explanation,
  step,
  action,
  settingsAction,
  startLabel,
  againLabel,
  extra,
}: {
  title: string;
  explanation: string;
  step: Step & { fraction?: number };
  action: SetupAction;
  settingsAction?: SetupAction;
  startLabel: string;
  againLabel: string;
  extra?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{explanation}</CardDescription>
      </CardHeader>
      {(extra || (step.status === "problem" && step.message)) && (
        <CardContent className="space-y-2 pt-0">
          {extra}
          {step.status === "problem" && step.message && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{step.message}</p>
          )}
        </CardContent>
      )}
      <CardFooter>
        <StepActions step={step} startLabel={startLabel} againLabel={againLabel} action={action} settingsAction={settingsAction} />
      </CardFooter>
    </Card>
  );
}

export function SetupApp() {
  const [view, setView] = useState<SetupViewState | null>(null);

  useEffect(() => {
    const unsubscribe = window.electron.setup.onState(setView);
    window.electron.setup.ready();
    return unsubscribe;
  }, []);

  if (!view) return null;

  const { name, complete, state } = view;
  const modelProgress =
    state.models.status === "working"
      ? (
          <div className="space-y-1">
            <progress className="h-2 w-full accent-primary" max={100} value={Math.round(state.models.fraction * 100)} />
            <p className="text-sm text-muted-foreground">
              {state.models.fraction >= 1 ? "Preparing the models…" : `${Math.round(state.models.fraction * 100)}% downloaded`}
            </p>
          </div>
        )
      : undefined;

  return (
    <div className="mx-auto max-w-lg space-y-5 p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to {name}</h1>
        <p className="mt-2 text-muted-foreground">A few things to set up before the first call. Everything stays on this Mac.</p>
      </header>
      <SetupCard
        title="Microphone"
        explanation={`${name} records what you say in a call through your microphone. When you press the button, macOS asks whether to allow it.`}
        step={state.microphone}
        action="microphone"
        settingsAction="settings-microphone"
        startLabel="Allow microphone"
        againLabel="Try again"
      />
      <SetupCard
        title="System audio"
        explanation={`${name} records what the other people say by capturing your Mac's audio output. When you press the button, macOS asks whether to allow it.`}
        step={state.systemAudio}
        action="system-audio"
        settingsAction="settings-system-audio"
        startLabel="Allow system audio"
        againLabel="Try again"
      />
      <SetupCard
        title="Speech and speaker models"
        explanation={`${name} turns speech into text and tells speakers apart on your Mac, with no cloud service. The speech and speaker models need a one-time download.`}
        step={state.models}
        action="models"
        startLabel="Download models"
        againLabel="Try again"
        extra={modelProgress}
      />
      <SetupCard
        title="Summaries"
        explanation="Summaries are written by a model running in Ollama on your Mac. Ollama must be running with the model pulled. You can record without it and summarise later."
        step={state.ollama}
        action="ollama"
        startLabel="Check Ollama"
        againLabel="Check again"
      />
      {complete && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">You&apos;re set up</CardTitle>
            <CardDescription>{name} will ask before it records anything.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button type="button" onClick={() => window.electron.setup.act("done")}>Done</Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
