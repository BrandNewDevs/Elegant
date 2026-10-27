import { ArrowRight, AudioLines, AlertCircle, CheckCircle2, ExternalLink, Loader2, PartyPopper, UserRound } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { SetupViewState } from "../../shared/setup-view-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PERMISSIONS, PROMPT_NOTE, type PermissionCopy } from "@/lib/permissions";
import { useSetup } from "@/lib/use-setup";

type Stage = "welcome" | "name" | "microphone" | "systemAudio" | "ready";

const STAGES: Stage[] = ["welcome", "name", "microphone", "systemAudio", "ready"];

/** Starts at the first thing still missing, so a permission that is already allowed is never asked for again. */
function firstStage({ state }: SetupViewState): Stage {
  const mic = state.microphone.status === "done";
  const system = state.systemAudio.status === "done";
  if (mic && system) return "ready";
  if (mic) return "systemAudio";
  if (system) return "microphone";
  return "welcome";
}

function StageFrame({ icon, title, children, actions }: { icon: ReactNode; title: string; children: ReactNode; actions: ReactNode }) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center text-center" aria-labelledby="stage-title">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary [&_svg]:size-8">{icon}</div>
      <h1 id="stage-title" className="text-2xl font-semibold tracking-tight">
        {title}
      </h1>
      <div className="mt-3 max-w-sm space-y-3 text-muted-foreground">{children}</div>
      <div className="mt-8 flex flex-col items-center gap-3">{actions}</div>
    </section>
  );
}

/** Asks what to call the person; the name stands in for "You" in their Meetings. Optional, and changeable in Profile. */
function NameStage({ initial, onContinue }: { initial: string; onContinue: () => void }) {
  const [name, setName] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    window.electron.setup.setUserName(name);
    onContinue();
  };

  return (
    <form onSubmit={submit} className="flex flex-1 flex-col">
      <StageFrame
        icon={<UserRound aria-hidden />}
        title="What should we call you?"
        actions={
          <Button type="submit" size="lg">
            {name.trim() ? "Continue" : "Skip for now"}
            <ArrowRight aria-hidden />
          </Button>
        }
      >
        <p>Your name appears in place of &ldquo;You&rdquo; in transcripts and summaries. You can change it later in Profile.</p>
        <div className="space-y-2 pt-2 text-left">
          <Label htmlFor="user-name">Your name</Label>
          <Input id="user-name" autoFocus autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Kenny" />
        </div>
      </StageFrame>
    </form>
  );
}

function PermissionStage({ copy, name, view, onContinue }: { copy: PermissionCopy; name: string; view: SetupViewState; onContinue: () => void }) {
  const step = view.state[copy.key];
  const act = (action: PermissionCopy["action"]) => window.electron.setup.act(action);
  const Icon = copy.icon;

  return (
    <StageFrame
      icon={step.status === "done" ? <CheckCircle2 aria-hidden /> : <Icon aria-hidden />}
      title={step.status === "done" ? `${copy.title} allowed` : copy.title}
      actions={
        <>
          {step.status === "todo" && (
            <Button type="button" size="lg" onClick={() => act(copy.action)}>
              {copy.allowLabel}
            </Button>
          )}
          {step.status === "working" && (
            <Button type="button" size="lg" disabled>
              <Loader2 className="animate-spin" aria-hidden />
              Waiting for macOS…
            </Button>
          )}
          {step.status === "problem" && (
            <>
              <Button type="button" size="lg" onClick={() => act(copy.action)}>
                Check again
              </Button>
              <Button type="button" variant="link" onClick={() => act(copy.settingsAction)}>
                <ExternalLink aria-hidden />
                Open System Settings
              </Button>
            </>
          )}
          {step.status === "done" && (
            <Button type="button" size="lg" onClick={onContinue}>
              Continue
              <ArrowRight aria-hidden />
            </Button>
          )}
        </>
      }
    >
      {step.status === "done" ? (
        <p>You will not be asked again.</p>
      ) : (
        <>
          <p>{copy.purpose(name)}</p>
          <p>{PROMPT_NOTE}</p>
        </>
      )}
      <div aria-live="polite">
        {step.status === "problem" && step.message && (
          <Alert variant="destructive" className="text-left">
            <AlertCircle className="size-4" aria-hidden />
            <AlertDescription>{step.message}</AlertDescription>
          </Alert>
        )}
      </div>
    </StageFrame>
  );
}

export function OnboardingApp() {
  const view = useSetup();
  const [chosen, setChosen] = useState<Stage | null>(null);
  if (!view) return null;

  const stage = chosen ?? firstStage(view);
  const next = (from: Stage) => setChosen(STAGES[STAGES.indexOf(from) + 1] ?? "ready");

  return (
    <main className="flex min-h-screen flex-col p-8">
      <ol className="flex justify-center gap-2" aria-label="Progress">
        {STAGES.map((s) => (
          <li
            key={s}
            aria-current={s === stage ? "step" : undefined}
            className={`h-1.5 w-8 rounded-full ${STAGES.indexOf(s) <= STAGES.indexOf(stage) ? "bg-primary" : "bg-primary/20"}`}
          >
            <span className="sr-only">{s}</span>
          </li>
        ))}
      </ol>
      {stage === "welcome" && (
        <StageFrame
          icon={<AudioLines aria-hidden />}
          title={`Welcome to ${view.name}`}
          actions={
            <Button type="button" size="lg" onClick={() => next("welcome")}>
              Get started
              <ArrowRight aria-hidden />
            </Button>
          }
        >
          <p>{view.name} notices when you join a call and offers to record, transcribe and summarise it. Everything stays on this Mac.</p>
          <p>It needs two permissions from macOS. This takes a minute, and you only do it once.</p>
        </StageFrame>
      )}
      {stage === "name" && <NameStage initial={view.userName} onContinue={() => next("name")} />}
      {stage === "microphone" && <PermissionStage copy={PERMISSIONS.microphone} name={view.name} view={view} onContinue={() => next("microphone")} />}
      {stage === "systemAudio" && <PermissionStage copy={PERMISSIONS.systemAudio} name={view.name} view={view} onContinue={() => next("systemAudio")} />}
      {stage === "ready" && (
        <StageFrame
          title="You're all set"
          icon={<PartyPopper aria-hidden />}
          actions={
            <>
              <Button type="button" size="lg" onClick={() => window.electron.setup.act("done")}>
                Done
              </Button>
              <Button type="button" variant="link" onClick={() => window.electron.setup.act("open-settings")}>
                Open Settings
              </Button>
            </>
          }
        >
          <p>{view.name} will ask before it records anything.</p>
          <p>Open Settings to download the speech models and check that Summaries are ready. You can do that at any time.</p>
        </StageFrame>
      )}
    </main>
  );
}
