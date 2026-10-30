import { Bell, CheckCircle2, Cpu, Download, ExternalLink, Loader2, Monitor, Moon, RefreshCw, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Trash2, XCircle, AlertCircle, type LucideIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { UpdateState } from "../../core/updater";
import { APPEARANCES, type Appearance } from "../../shared/appearance";
import { DEFAULT_SUMMARY_MODEL } from "../../shared/summary-model";
import { MODEL_KINDS, type ModelFile, type ModelKind } from "../../shared/model-kinds";
import type { Step } from "../../setup/setup";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PERMISSIONS, type PermissionCopy, type PermissionStep } from "@/lib/permissions";
import { useSetup } from "@/lib/use-setup";
import { cn } from "@/lib/utils";
import { restartForUpdate } from "../meetings/update-actions";

import type { AISettingsAction, AISettingsView, GeminiModelOption } from "../../shared/ai-settings";

export const SECTIONS = ["General", "Permissions", "Models", "Providers", "Updates"] as const;
export type SettingsSection = (typeof SECTIONS)[number];

const SECTION_ICON: Record<SettingsSection, LucideIcon> = { General: SlidersHorizontal, Permissions: ShieldCheck, Models: Cpu, Providers: Sparkles, Updates: Bell };

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
function SettingRow({ title, htmlFor, description, children, below, stacked }: { title: string; htmlFor?: string; description?: ReactNode; children?: ReactNode; below?: ReactNode; stacked?: boolean }) {
  return (
    <div className="py-4">
      <div className={cn("flex gap-x-6 gap-y-3", stacked ? "flex-col" : description ? "items-start justify-between" : "items-center justify-between")}>
        <div className="min-w-0 space-y-1">
          {htmlFor ? <Label htmlFor={htmlFor} className="text-sm font-medium">{title}</Label> : <h3 className="text-sm font-medium">{title}</h3>}
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
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

const APPEARANCE_OPTION: Record<Appearance, { label: string; Icon: LucideIcon }> = {
  system: { label: "System", Icon: Monitor },
  light: { label: "Light", Icon: Sun },
  dark: { label: "Dark", Icon: Moon },
};

/** Picks how the windows are coloured; one option is always chosen. */
function AppearancePicker({ appearance }: { appearance: Appearance }) {
  return (
    <div role="radiogroup" aria-label="Appearance" className="inline-flex gap-0.5 rounded-lg border bg-muted/40 p-0.5">
      {APPEARANCES.map((id) => {
        const { label, Icon } = APPEARANCE_OPTION[id];
        const chosen = appearance === id;
        return (
          <Button
            key={id}
            type="button"
            role="radio"
            aria-checked={chosen}
            size="sm"
            variant={chosen ? "secondary" : "ghost"}
            className={cn("h-7 px-2.5", chosen ? "bg-background shadow-sm hover:bg-background" : "text-muted-foreground")}
            onClick={() => window.electron.meetings.setAppearance(id)}
          >
            <Icon aria-hidden />
            {label}
          </Button>
        );
      })}
    </div>
  );
}

function General({ appearance, showInDock, keepAudio, userName }: { appearance: Appearance; showInDock: boolean; keepAudio: boolean; userName: string }) {
  return (
    <div className="divide-y">
      <SettingRow stacked title="Your name" htmlFor="user-name" description={<>Used instead of &ldquo;You&rdquo; in every Transcript, Summary and export. Stays on this Mac.</>}>
        {/* Keyed on the saved name so the field follows a change made elsewhere. */}
        <NameForm key={userName} userName={userName} />
      </SettingRow>
      <SettingRow title="Appearance">
        <AppearancePicker appearance={appearance} />
      </SettingRow>
      <SettingRow title="Show in Dock" htmlFor="show-in-dock">
        <Switch id="show-in-dock" checked={showInDock} onCheckedChange={(checked) => window.electron.meetings.setShowInDock(checked)} />
      </SettingRow>
      <SettingRow title="Keep audio after transcription" htmlFor="keep-audio" description="Keep each Recording's audio on this Mac after it is transcribed, until you delete the Meeting. Off by default, so the audio is deleted once the Transcript exists. Applies from the next transcription.">
        <Switch id="keep-audio" checked={keepAudio} onCheckedChange={(checked) => window.electron.meetings.setKeepAudio(checked)} />
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
      <p className="text-sm text-muted-foreground">macOS asks once and remembers your answer.</p>
      <div className="divide-y">
        <PermissionRow copy={PERMISSIONS.microphone} step={state.microphone} name={name} />
        <PermissionRow copy={PERMISSIONS.systemAudio} step={state.systemAudio} name={name} />
      </div>
    </>
  );
}

/** Picks the Ollama model that writes Summaries from the ones pulled; any model but the tested default is cautioned about. */
function SummaryModelPicker({ model, ollama }: { model: string; ollama: Step["status"] }) {
  const [installed, setInstalled] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    void window.electron.meetings.installedModels().then((names) => current && setInstalled(names));
    return () => {
      current = false;
    };
  }, [ollama]); // look again once Ollama is found or its check finishes
  const options = [...new Set([...installed, model])].sort((a, b) => a.localeCompare(b));
  const label = (option: string) =>
    option + (installed.length > 0 && !installed.includes(option) ? " (not pulled)" : "");
  return (
    <Select
      value={model}
      onValueChange={(next) => {
        window.electron.meetings.setSummaryModel(next);
        toast("Summary model changed", { description: "New Summaries use it. Regenerate a Summary to redo an existing one." });
      }}
    >
      <SelectTrigger id="summary-model" className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {label(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const MODEL_ROW: Record<ModelKind, { title: string; description: string; noun: string }> = {
  speech: { title: "Speech model", description: "Whisper large-v3 turns speech into text.", noun: "speech model" },
  speaker: { title: "Speaker model", description: "Pyannote tells Participants apart.", noun: "speaker model" },
};

const formatSize = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/**
 * The speech and speaker models on this Mac, each with its size and buttons to remove it or fetch it again, and the one
 * download that fetches whatever is missing. Both kinds are fetched together, so their progress and problems are shared.
 */
function DownloadedModels({ models, name }: { models: Step & { fraction: number }; name: string }) {
  const [files, setFiles] = useState<ModelFile[]>();
  const [asked, setAsked] = useState<{ kind: ModelKind; action: "remove" | "redownload" }>();
  useEffect(() => {
    let current = true;
    void window.electron.meetings.modelFiles().then((found) => current && setFiles(found));
    return () => {
      current = false;
    };
  }, [models.status]); // a download starting, finishing or failing, or a removal, changes what is on disk
  const downloading = models.status === "working";
  const percent = Math.round(models.fraction * 100);
  const anyMissing = files !== undefined && MODEL_KINDS.some((kind) => !files.find((file) => file.kind === kind)?.present);

  const confirm = async () => {
    if (!asked) return;
    const { kind, action } = asked;
    setAsked(undefined);
    const result = await (action === "remove" ? window.electron.meetings.removeModel(kind) : window.electron.meetings.redownloadModel(kind));
    if (!result.ok) toast.error(result.reason);
    setFiles(await window.electron.meetings.modelFiles());
  };

  return (
    <>
      {MODEL_KINDS.map((kind) => {
        const file = files?.find((f) => f.kind === kind);
        const copy = MODEL_ROW[kind];
        return (
          <SettingRow
            key={kind}
            title={copy.title}
            description={copy.description}
            below={
              file?.present && !downloading ? (
                <div className="flex gap-2 pt-3">
                  <Button type="button" size="sm" variant="outline" onClick={() => setAsked({ kind, action: "redownload" })}>
                    <RefreshCw aria-hidden />
                    Redownload
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setAsked({ kind, action: "remove" })}>
                    <Trash2 aria-hidden />
                    Remove
                  </Button>
                </div>
              ) : undefined
            }
          >
            {downloading && <Status label="Downloading…" variant="warning" />}
            {!downloading && file?.present && <Status label={`Downloaded · ${formatSize(file.bytes)}`} variant="success" />}
            {!downloading && file && !file.present && <Status label="Not downloaded" variant="secondary" />}
          </SettingRow>
        );
      })}
      {(downloading || models.status === "problem" || (files && anyMissing)) && (
        <div className="space-y-3 py-4">
          {downloading && (
            <div className="space-y-1">
              <Progress value={percent} aria-label="Model download" />
              <p className="text-sm text-muted-foreground">{models.fraction >= 1 ? "Preparing the models…" : `${percent}% downloaded`}</p>
            </div>
          )}
          {models.status === "problem" && models.message && <Problem>{models.message}</Problem>}
          {!downloading && (
            <Button type="button" onClick={() => window.electron.setup.act("models")}>
              {models.status === "problem" ? <RefreshCw aria-hidden /> : <Download aria-hidden />}
              {models.status === "problem" ? "Try again" : "Download models"}
            </Button>
          )}
        </div>
      )}
      <Dialog open={asked !== undefined} onOpenChange={(open) => !open && setAsked(undefined)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{asked?.action === "remove" ? "Remove" : "Redownload"} the {asked ? MODEL_ROW[asked.kind].noun : "model"}?</DialogTitle>
            <DialogDescription>
              {asked?.action === "remove"
                ? `It is deleted from this Mac and downloaded again the next time ${name} needs it, so the next Transcript waits for the download.`
                : "It is deleted and downloaded again, which needs an internet connection. Nothing can be recorded or transcribed until it finishes."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAsked(undefined)}>
              Cancel
            </Button>
            <Button type="button" variant={asked?.action === "remove" ? "destructive" : "default"} onClick={() => void confirm()}>
              {asked?.action === "remove" ? "Remove" : "Redownload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Models({ models, name }: { models: Step & { fraction: number }; name: string }) {
  return (
    <div className="divide-y">
      <DownloadedModels models={models} name={name} />
    </div>
  );
}

/** One provider of the AI that writes Summaries and answers questions about a Meeting. */
function ProviderCard({ title, where, active, children }: { title: string; where: "Local" | "Cloud"; active: boolean; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-4 rounded-lg border p-4">
      <header className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge variant="secondary">{where}</Badge>
        {active && <Status label="In use" variant="success" />}
      </header>
      {children}
    </section>
  );
}

/** Ollama: runs on this Mac. Its readiness only matters while it is the provider in use. */
function OllamaCard({ ollama, summaryModel, active, busy, onUse }: { ollama: Step; summaryModel: string; active: boolean; busy: boolean; onUse?: () => void }) {
  return (
    <ProviderCard title="Ollama" where="Local" active={active}>
      <p className="text-sm text-muted-foreground">A model running on your Mac writes each Summary. Nothing about your Meetings leaves it.</p>
      <SettingRow
        title="Summary model"
        htmlFor="summary-model"
        description={summaryModel === DEFAULT_SUMMARY_MODEL ? undefined : "Not tested with Elegant's Summaries, so results may be worse or fail validation."}
      >
        <SummaryModelPicker model={summaryModel} ollama={ollama.status} />
      </SettingRow>
      {active && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            {ollama.status === "done" && <Status label="Ready" variant="success" />}
            {ollama.status === "working" && <Status label="Checking…" variant="warning" />}
            {ollama.status === "problem" && <Status label="Not ready" variant="destructive" />}
            {ollama.status !== "working" && (
              <Button type="button" size="sm" variant={ollama.status === "done" ? "outline" : "default"} onClick={() => window.electron.setup.act("ollama")}>
                <RefreshCw aria-hidden />
                {ollama.status === "todo" ? "Check Ollama" : "Check again"}
              </Button>
            )}
          </div>
          {ollama.status === "problem" && ollama.message && <Problem>{ollama.message}</Problem>}
          <p className="text-sm text-muted-foreground">Start Ollama and pull the model first; you can record without it and summarise later.</p>
        </div>
      )}
      {onUse && !active && (
        <Button type="button" variant="outline" disabled={busy} onClick={onUse}>
          Use Ollama
        </Button>
      )}
    </ProviderCard>
  );
}

/** Picks the Gemini text model from the ones Google says this key can use, loaded when a key is saved and on request. */
function GeminiModelPicker({ ai, busy, configure }: { ai: AISettingsView; busy: boolean; configure: (action: AISettingsAction) => Promise<boolean> }) {
  const [models, setModels] = useState<GeminiModelOption[]>();
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!ai.hasGeminiKey) {
      setModels(undefined);
      setProblem("");
      return;
    }
    let current = true;
    setLoading(true);
    setProblem("");
    window.electron.setup
      .geminiModels()
      .then((found) => current && setModels(found))
      .catch((error: unknown) => current && setProblem(error instanceof Error ? error.message : "The model list could not be loaded"))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [ai.hasGeminiKey, reload]); // a saved or replaced key, or the Refresh button, asks Google again
  const options = models ?? [];
  const saved = ai.geminiModel;
  const listed = options.some((m) => m.id === saved); // the saved model is shown even before the list arrives, or if Google no longer lists it
  return (
    <div className="space-y-2">
      <Label htmlFor="gemini-model">Gemini text model</Label>
      <div className="flex items-center gap-2">
        <Select value={saved} disabled={busy || !ai.hasGeminiKey} onValueChange={(next) => void configure({ type: "model", model: next })}>
          <SelectTrigger id="gemini-model" className="w-72">
            <SelectValue placeholder={ai.hasGeminiKey ? "Loading models…" : "Save a key to load models"} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.id}
              </SelectItem>
            ))}
            {!listed && (
              <SelectItem value={saved}>
                {saved}
                {models ? " (not listed)" : ""}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        <Button type="button" size="icon" variant="ghost" aria-label="Refresh models" title="Refresh models" disabled={!ai.hasGeminiKey || loading} onClick={() => setReload((n) => n + 1)}>
          <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden />
        </Button>
      </div>
      {problem && <p className="text-sm text-destructive">{problem}</p>}
      {!problem && models && models.length === 0 && <p className="text-sm text-muted-foreground">This key has no Gemini text models available.</p>}
    </div>
  );
}

/** Gemini: opt-in cloud processing with the person's own key. Saving or testing a key never turns it on; consent and Use Gemini do. */
function GeminiCard({ ai, busy, configure }: { ai: AISettingsView; busy: boolean; configure: (action: AISettingsAction) => Promise<boolean> }) {
  const [key, setKey] = useState("");
  const [consent, setConsent] = useState(false);
  const active = ai.provider === "gemini";
  return (
    <ProviderCard title="Gemini" where="Cloud" active={active}>
      <p className="text-sm text-muted-foreground">Sends Transcript evidence and questions to Google using your own account, and may incur charges. Audio always stays on your Mac.</p>
      <div className="space-y-2">
        <Label htmlFor="gemini-key">Gemini API key</Label>
        <Input id="gemini-key" type="password" autoComplete="off" spellCheck={false} maxLength={512} value={key} placeholder={ai.hasGeminiKey ? "A key is saved securely" : "Enter your API key"} onChange={(event) => setKey(event.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy || !key.trim()}
            onClick={() => void configure({ type: "save-key", key }).then((saved) => saved && setKey(""))}
          >
            {ai.hasGeminiKey ? "Replace key" : "Save key"}
          </Button>
          <Button type="button" variant="outline" disabled={busy || !ai.hasGeminiKey} onClick={() => void configure({ type: "remove-key" }).then((removed) => removed && setKey(""))}>
            Remove key
          </Button>
        </div>
      </div>
      <GeminiModelPicker ai={ai} busy={busy} configure={configure} />
      <Button type="button" variant="outline" disabled={busy || !ai.hasGeminiKey} onClick={() => void configure({ type: "test" })}>
        Test Gemini connection
      </Button>
      {!active && (
        <div className="space-y-3 border-t pt-4">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={consent} onChange={(event) => setConsent(event.target.checked)} />I agree to send Transcript evidence and questions to Google when using Gemini.
          </label>
          <Button type="button" disabled={busy || !consent || !ai.hasGeminiKey} onClick={() => void configure({ type: "select", provider: "gemini", consent: true })}>
            Use Gemini
          </Button>
        </div>
      )}
    </ProviderCard>
  );
}

/** The providers on offer: which one writes Summaries and answers questions, and each one's own settings. One choice covers new work. */
function Providers({ ollama, summaryModel, ai }: { ollama: Step; summaryModel: string; ai?: AISettingsView }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  /** Runs the change; says whether it was made, and shows what went wrong when it was not. */
  const configure = async (action: AISettingsAction): Promise<boolean> => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setMessage(await window.electron.setup.configureAI(action));
      return true;
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "AI settings could not be saved");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const provider = ai?.provider ?? "ollama";
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Choose what writes Summaries and answers questions about a Meeting. It applies to new work; Summaries and chats already written stay as they are. Recording, transcription and telling speakers apart always run on this Mac.</p>
      <OllamaCard ollama={ollama} summaryModel={summaryModel} active={provider === "ollama"} busy={busy} onUse={ai ? () => void configure({ type: "select", provider: "ollama" }) : undefined} />
      {ai && <GeminiCard ai={ai} busy={busy} configure={configure} />}
      {busy && <p role="status" className="text-sm">Updating AI settings…</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
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
      <SettingRow title="Check for updates" htmlFor="check-for-updates">
        <Switch id="check-for-updates" checked={checkForUpdates} onCheckedChange={(checked) => window.electron.meetings.setCheckForUpdates(checked)} />
      </SettingRow>
    </div>
  );
}

/**
 * Settings, as a modal over the Meetings window: a list of sections on the left and one section at a time on the right. Its
 * close button, Esc, or a click outside close it (`onBack`), which returns to the Meeting that was open.
 */
export function SettingsPage({
  section,
  onSectionChange,
  onBack,
  appearance = "system",
  summaryModel = DEFAULT_SUMMARY_MODEL,
  showInDock = true,
  keepAudio = false,
  checkForUpdates = true,
  update = { status: "idle" },
  appVersion,
}: {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onBack: () => void;
  appearance?: Appearance;
  summaryModel?: string;
  showInDock?: boolean;
  keepAudio?: boolean;
  checkForUpdates?: boolean;
  update?: UpdateState;
  appVersion?: string;
}) {
  const view = useSetup();

  return (
    <Dialog open onOpenChange={(open) => !open && onBack()}>
      <DialogContent aria-describedby={undefined} className="h-[min(40rem,85vh)] max-w-3xl gap-0 overflow-hidden p-0 sm:rounded-xl">
        <section aria-label="Settings" className="flex h-full min-h-0">
          <nav aria-label="Settings sections" className="w-44 shrink-0 space-y-1 border-r bg-muted/30 p-3">
            <p className="mb-3 px-3 pt-1 text-sm font-semibold">Settings</p>
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
            <DialogTitle asChild>
              <h1 className="mb-2 text-xl font-semibold tracking-tight">{section}</h1>
            </DialogTitle>
            {view && (
              <>
                {section === "General" && <General appearance={appearance} showInDock={showInDock} keepAudio={keepAudio} userName={view.userName} />}
                {section === "Permissions" && <Permissions state={view.state} name={view.name} />}
                {section === "Models" && <Models models={view.state.models} name={view.name} />}
                {section === "Providers" && <Providers ollama={view.state.ollama} summaryModel={summaryModel} ai={view.ai} />}
                {section === "Updates" && <Updates checkForUpdates={checkForUpdates} update={update} appVersion={appVersion} name={view.name} />}
              </>
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
