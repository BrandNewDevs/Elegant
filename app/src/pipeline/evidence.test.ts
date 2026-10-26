import { expect, it } from "vitest";
import { fixtureTranscript } from "../testing/fake-pipeline.js";
import { transcriptRevision, resolveReference } from "./evidence.js";

it("keeps ordered content identity and rejects stale or out-of-range evidence", () => {
  const revision = transcriptRevision(fixtureTranscript);
  expect(resolveReference(fixtureTranscript, { revision, refs: [1] })[0]?.segment.speaker).toBe("Speaker 1");
  const changed = { segments: [...fixtureTranscript.segments].reverse() };
  expect(transcriptRevision(changed)).not.toBe(revision);
  expect(() => resolveReference(changed, { revision, refs: [1] })).toThrow("older Transcript");
  expect(() => resolveReference(fixtureTranscript, { revision, refs: [99] })).toThrow("Unknown");
  expect(() => resolveReference(fixtureTranscript, { revision, refs: [0, 0] })).toThrow("distinct");
});
