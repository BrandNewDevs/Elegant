import { useState } from "react";
import type { AISettingsAction, AISettingsView } from "../../shared/ai-settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Only provider configuration; the existing local status and permission UI stays intact. */
export function AIProviderSettings({ ai }: { ai: AISettingsView }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(ai.geminiModel);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function configure(action: AISettingsAction) {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await window.electron.setup.configureAI(action);
      if (action.type === "save-key" || action.type === "remove-key") setKey("");
      setMessage(result);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "AI settings could not be saved"); }
    finally { setBusy(false); }
  }
  return <section aria-label="AI provider" className="space-y-3 py-4">
    <header className="space-y-1">
      <h3 className="text-sm font-medium">AI provider</h3>
      <p className="text-sm text-muted-foreground">Current: {ai.provider === "ollama" ? "Ollama · local" : `Gemini · ${ai.geminiModel}`}. Changes apply to new Summary and Chat operations.</p>
    </header>
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Ollama processes your Meetings on your Mac. Gemini sends Transcript evidence and questions to Google using your account and may incur charges. Audio processing stays local.</p>
      <Button type="button" variant="outline" disabled={busy || ai.provider === "ollama"} onClick={() => void configure({ type: "select", provider: "ollama" })}>Use Ollama</Button>
      <div className="space-y-2">
        <Label htmlFor="gemini-key">Gemini API key</Label>
        <Input id="gemini-key" type="password" autoComplete="off" spellCheck={false} maxLength={512} value={key} placeholder={ai.hasGeminiKey ? "A key is saved securely" : "Enter your API key"} onChange={event => setKey(event.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy || !key.trim()} onClick={() => void configure({ type: "save-key", key })}>{ai.hasGeminiKey ? "Replace key" : "Save key"}</Button>
          <Button type="button" variant="outline" disabled={busy || !ai.hasGeminiKey} onClick={() => void configure({ type: "remove-key" })}>Remove key</Button>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="gemini-model">Gemini text model</Label>
        <Input id="gemini-model" value={model} maxLength={110} onChange={event => setModel(event.target.value)} />
        <Button type="button" variant="outline" disabled={busy || model === ai.geminiModel} onClick={() => void configure({ type: "model", model })}>Save model</Button>
      </div>
      <Button type="button" variant="outline" disabled={busy || !ai.hasGeminiKey || model !== ai.geminiModel} onClick={() => void configure({ type: "test" })}>Test Gemini connection</Button>
      <p className="text-xs text-muted-foreground">Connection test uses saved model: {ai.geminiModel}. Save model changes before testing.</p>
      {busy && <Button type="button" variant="outline" onClick={() => { void window.electron.setup.configureAI({ type: "cancel-test" }).catch(() => {}); }}>Cancel connection test</Button>}
      {ai.provider !== "gemini" && <>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />I agree to send Transcript evidence and questions to Google when using Gemini.</label>
        <Button type="button" disabled={busy || !consent || !ai.hasGeminiKey} onClick={() => void configure({ type: "select", provider: "gemini", consent: true })}>Use Gemini</Button>
      </>}
      {busy && <p role="status" className="text-sm">Updating AI settings…</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    </div>
  </section>;
}
