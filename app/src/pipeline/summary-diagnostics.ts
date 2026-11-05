/** Content-bearing evaluation diagnostics. Never attach to persisted Summary metadata.
 * Callers must explicitly opt in; the evaluation CLI permits synthetic runs only.
 */
export interface SummaryDiagnostic {
  stage: string;
  event: 'accepted' | 'rejected' | 'fallback' | 'checkpoint' | 'transport-error';
  call?: number;
  attempt?: number;
  reason?: string;
  data?: unknown;
}
export type SummaryObserver = (event: SummaryDiagnostic) => void;

/** Observers cannot mutate pipeline state or turn a successful generation into a failure. */
export function summaryDiagnostics(observer?: SummaryObserver): SummaryObserver {
  return event => {
    if (!observer) return;
    try { observer(structuredClone(event)); } catch { /* Diagnostics are best effort. */ }
  };
}
