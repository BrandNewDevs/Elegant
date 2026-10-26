import type { Transcript } from "../../pipeline/pipeline";
import { formatClock } from "@/lib/format";

export type OpenEvidence = (revision: string, refs: number[]) => void;

/** Reference identity comes from the main process; timestamps are presentation only. */
export function Citations({ revision, refs, transcript, onOpen }: {
  revision: string; refs: number[]; transcript: Transcript; onOpen: OpenEvidence;
}) {
  if (!refs.length) return null;
  return <span className="ml-1 inline-flex flex-wrap gap-1 align-baseline">
    {refs.map(ref => {
      const segment = transcript.segments[ref];
      if (!segment) return null;
      const timestamp = formatClock(segment.start);
      return <button key={ref} type="button" onClick={() => onOpen(revision, [ref])}
        className="rounded px-1 font-mono text-[11px] text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`View Transcript at ${timestamp}`} title={`View ${segment.speaker} at ${timestamp}`}>
        [{timestamp}]
      </button>;
    })}
  </span>;
}
