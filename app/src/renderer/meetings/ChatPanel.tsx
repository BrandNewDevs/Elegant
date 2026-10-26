import { AlertCircle, ArrowUp, Loader2, MessageSquare, RotateCcw, Square, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { MeetingsViewState } from "../../shared/meetings-view-state";
import type { ChatStatus } from "../../shared/meeting-chat";
import type { Transcript } from "../../pipeline/pipeline";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Citations, type OpenEvidence } from "./Citations";

const ACTIVE = new Set<ChatStatus>(["queued", "retrieving", "generating"]);
const LABELS: Record<ChatStatus, string> = { queued: "Queued", retrieving: "Finding evidence", generating: "Writing answer", completed: "Answered", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" };

export function ChatPanel({ meetingId, chat, transcript, onOpen, isCurrent }: {
  meetingId: number; chat: MeetingsViewState["chat"]; transcript: Transcript; onOpen: OpenEvidence; isCurrent: () => boolean;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [retryQuestion, setRetryQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const operation = useRef(0);
  const history = chat?.history ?? [];
  const available = chat?.available ?? false;
  const hasActive = history.some(record => ACTIVE.has(record.status));
  const tooLong = draft.length > 2000;
  async function send(question: string, fromDraft = false) {
    if (!available || hasActive || sending || !question.trim() || question.length > 2000) return;
    const token = ++operation.current;
    setSending(true); setError(""); setRetryQuestion("");
    try {
      await window.electron.meetings.sendQuestion({ meetingId, requestId: crypto.randomUUID(), question: question.trim() });
      if (isCurrent() && token === operation.current && fromDraft) setDraft(current => current === question ? "" : current);
    } catch (problem) {
      if (isCurrent() && token === operation.current) { setError(problem instanceof Error ? problem.message : "The question could not be sent."); setRetryQuestion(question); }
    } finally { if (isCurrent() && token === operation.current) setSending(false); }
  }
  async function cancel(requestId: string) {
    setError("");
    try { await window.electron.meetings.cancelQuestion({ meetingId, requestId }); }
    catch (problem) { if (isCurrent()) setError(problem instanceof Error ? problem.message : "The answer could not be cancelled."); }
  }
  async function clear() {
    ++operation.current; setSending(false); setClearing(true); setError(""); setRetryQuestion("");
    try { await window.electron.meetings.clearChat(meetingId); }
    catch (problem) { if (isCurrent()) setError(problem instanceof Error ? problem.message : "Chat could not be cleared."); }
    finally { if (isCurrent()) setClearing(false); }
  }
  return <div className="space-y-5">
    <div className="flex items-start justify-between gap-4">
      <div><h2 className="text-sm font-medium">Ask about this Meeting</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Answers use the Transcript. Follow a timestamp to check the source.</p></div>
      <Button type="button" variant="ghost" size="sm" disabled={!history.length || clearing} onClick={() => void clear()}><Trash2 aria-hidden />Clear chat</Button>
    </div>
    {!available && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Chat becomes available when this Meeting's Transcript is ready.</p>}
    {!history.length && available && <div className="rounded-lg border border-dashed px-5 py-8 text-center">
      <MessageSquare className="mx-auto mb-3 size-5 text-muted-foreground" aria-hidden /><p className="text-sm">What was decided? Who committed to what?</p><p className="mt-1 text-xs text-muted-foreground">Questions and answers stay on this machine.</p>
    </div>}
    <ol aria-label="Chat history" className="space-y-5">{history.map(record => <li key={record.id} className="space-y-3">
      <div className="ml-8 rounded-lg bg-muted px-4 py-3"><p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Your question</p><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{record.question}</p></div>
      <div className="space-y-2 border-l-2 border-primary/40 pl-4">
        <div className="flex flex-wrap items-center gap-2" aria-live={ACTIVE.has(record.status) ? "polite" : undefined}>
          <Badge variant={record.status === "failed" ? "destructive" : "outline"}>{ACTIVE.has(record.status) && <Loader2 className="size-3 animate-spin" aria-hidden />}{LABELS[record.status]}</Badge>
          {ACTIVE.has(record.status) && <Button type="button" variant="ghost" size="sm" onClick={() => void cancel(record.id)} aria-label="Cancel answer"><Square aria-hidden />Cancel</Button>}
        </div>
        {record.status === "completed" && record.answer && <div>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{record.answer.text}<Citations revision={record.revision} refs={record.answer.refs} transcript={transcript} onOpen={onOpen} /></p>
        </div>}
        {["failed", "cancelled", "interrupted"].includes(record.status) && <div className="space-y-2">
          <p className="text-xs leading-relaxed text-muted-foreground">{record.error ?? (record.status === "cancelled" ? "This answer was cancelled." : "This answer did not complete.")}</p>
          <Button type="button" variant="outline" size="sm" disabled={!available || hasActive || sending} onClick={() => void send(record.question)} aria-label="Retry question"><RotateCcw aria-hidden />Retry</Button>
        </div>}
      </div>
    </li>)}</ol>
    {error && <Alert variant="destructive" role="alert"><AlertCircle className="size-4" aria-hidden /><AlertDescription>{error}{retryQuestion && <Button type="button" variant="outline" size="sm" className="ml-2" disabled={sending || hasActive || !available} onClick={() => void send(retryQuestion)}><RotateCcw aria-hidden />Retry sending</Button>}</AlertDescription></Alert>}
    <form onSubmit={event => { event.preventDefault(); void send(draft, true); }} className="rounded-lg border bg-card p-3 focus-within:ring-1 focus-within:ring-ring">
      <label htmlFor={`meeting-${meetingId}-question`} className="sr-only">Question about this Meeting</label>
      <textarea id={`meeting-${meetingId}-question`} value={draft} disabled={!available || clearing} rows={3}
        placeholder="Ask about decisions, commitments, or a discussion…"
        className="w-full resize-y bg-transparent text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        aria-invalid={tooLong || undefined} aria-describedby={`meeting-${meetingId}-question-help`}
        onChange={event => setDraft(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(draft, true); }
        }} />
      <div className="mt-2 flex items-center justify-between gap-3 border-t pt-3">
        <p id={`meeting-${meetingId}-question-help`} className={cn("text-[11px]", tooLong ? "text-destructive" : "text-muted-foreground")} role={tooLong ? "alert" : undefined}>{tooLong ? "Questions must be 2,000 characters or fewer." : "Enter to send · Shift+Enter for a new line"} <span className="tabular-nums">{draft.length}/2,000</span></p>
        <Button type="submit" size="sm" disabled={!available || !draft.trim() || tooLong || hasActive || sending || clearing}>{sending ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowUp aria-hidden />}Send</Button>
      </div>
    </form>
  </div>;
}
