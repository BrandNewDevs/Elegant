import { describe, expect, it } from "vitest";
import type { PipelineStages, Summary, Transcript } from "../pipeline/pipeline.js";
import { openStore } from "../store/store.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { canonicaliseParticipantMentions } from "./participants.js";
import { AppCore } from "./app-core.js";

const transcript: Transcript = {
  segments: [
    { start: 0, end: 2, speaker: "You", text: "Where are we on the launch?" },
    { start: 2.5, end: 5, speaker: "Speaker 1", text: "Nearly there." },
    { start: 5.5, end: 8, speaker: "Speaker 2", text: "Still waiting on legal." },
    { start: 9, end: 10, speaker: "Speaker 1", text: "Fine by me." },
  ],
};

const summary: Summary = {
  tldr: "Speaker 1 says the launch is nearly there while Speaker 2 waits on legal. Speaker 10 is not here.",
  participants: [
    { speaker: "You", said: ["Asked about the launch."] },
    { speaker: "Speaker 1", said: ["The launch is nearly ready.", "Speaker 2 should chase legal."] },
    { speaker: "Speaker 2", said: ["Legal has not signed off."] },
  ],
};

const pipeline: PipelineStages = {
  transcribe: async () => transcript,
  summarise: async () => summary,
};

async function recordedMeeting() {
  const engine = new FakeEngine();
  const store = openStore(":memory:");
  const core = new AppCore({ engine, store, pipeline });
  core.start();
  engine.emit({ type: "ready", version: "0.1.0" });
  engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
  engine.emit({ type: "tracks_ready", micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav", micStartHostTime: 1000.197, systemStartHostTime: 1000 });
  await core.idle();
  const [meeting] = core.listMeetings();
  return { core, store, id: meeting!.id };
}

describe("renaming a Participant", () => {
  it("lists the Participants of a Meeting by label, with no names yet", async () => {
    const { core, id } = await recordedMeeting();
    expect(core.getMeeting(id)!.participants).toEqual([
      { label: "You", name: null },
      { label: "Speaker 1", name: null },
      { label: "Speaker 2", name: null },
    ]);
  });

  it("shows the name in the Transcript and the Summary of that Meeting", async () => {
    const { core, id } = await recordedMeeting();
    core.renameParticipant(id, "Speaker 1", "Priya");

    const shown = core.getMeetingForDisplay(id)!;
    expect(shown.transcript.segments.map((s) => s.speaker)).toEqual(["You", "Priya", "Speaker 2", "Priya"]);
    expect(shown.summary!.participants.map((p) => p.speaker)).toEqual(["You", "Priya", "Speaker 2"]);
    expect(shown.summary!.tldr).toBe("Priya says the launch is nearly there while Speaker 2 waits on legal. Speaker 10 is not here.");
    expect(shown.summary!.participants[1]!.said).toEqual(["The launch is nearly ready.", "Speaker 2 should chase legal."]);
    expect(shown.participants).toContainEqual({ label: "Speaker 1", name: "Priya" });
  });

  it("keeps labels, not names, in the stored Transcript and Summary", async () => {
    const { core, id } = await recordedMeeting();
    core.renameParticipant(id, "Speaker 1", "Priya");
    core.renameParticipant(id, "Speaker 2", "Sam");

    const stored = core.getMeeting(id)!;
    expect(stored.transcript).toEqual(transcript);
    expect(stored.summary).toEqual(summary);
  });

  it("leaves the Transcript's spoken words alone", async () => {
    const { core, id } = await recordedMeeting();
    core.renameParticipant(id, "Speaker 1", "Priya");
    expect(core.getMeetingForDisplay(id)!.transcript.segments.map((s) => s.text)).toEqual(transcript.segments.map((s) => s.text));
  });

  it("does not chain when a name is another Participant's label", async () => {
    const { core, id } = await recordedMeeting();
    core.renameParticipant(id, "Speaker 2", "Sam");
    core.renameParticipant(id, "Speaker 1", "Speaker 2");
    const shown = core.getMeetingForDisplay(id)!;
    expect(shown.summary!.tldr).toBe("Speaker 2 says the launch is nearly there while Sam waits on legal. Speaker 10 is not here.");
  });

  it("uses the displayed names in exported Summary prose without chaining labels", async () => {
    const { core, id } = await recordedMeeting();
    core.renameParticipant(id, "Speaker 2", "Sam");
    core.renameParticipant(id, "Speaker 1", "Speaker 2");

    await core.regenerateSummary(id);
    const { markdown } = core.exportMeeting(id);
    expect(markdown).toContain("Speaker 2 says the launch is nearly there while Sam waits on legal.");
    expect(markdown).toContain("### Speaker 2");
    expect(markdown).toContain("### Sam");
    expect(markdown).toContain("- Sam should chase legal.");
    expect(markdown).toContain("**Speaker 2** (0:02): Nearly there.");
    expect(core.getMeeting(id)!.summary).toEqual(summary);
  });

  it("can be changed, and cleared with a blank name", async () => {
    const { core, id } = await recordedMeeting();
    core.renameParticipant(id, "Speaker 1", "  Priya ");
    expect(core.getMeeting(id)!.participants[1]!.name).toBe("Priya");
    core.renameParticipant(id, "Speaker 1", "Priyanka");
    expect(core.getMeeting(id)!.participants[1]!.name).toBe("Priyanka");
    core.renameParticipant(id, "Speaker 1", "   ");
    expect(core.getMeeting(id)!.participants[1]!.name).toBeNull();
    expect(core.getMeetingForDisplay(id)!.transcript.segments[1]!.speaker).toBe("Speaker 1");
  });

  it("applies to one Meeting only", async () => {
    const engine = new FakeEngine();
    const store = openStore(":memory:");
  const core = new AppCore({ engine, store, pipeline });
    core.start();
    engine.emit({ type: "ready", version: "0.1.0" });
    for (const startedAt of ["2026-10-24T10:00:00.000Z", "2026-10-24T11:00:00.000Z"]) {
      engine.emit({ type: "recording_started", app: "zoom.us", startedAt });
      engine.emit({ type: "tracks_ready", micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav", micStartHostTime: 1, systemStartHostTime: 1 });
      await core.idle();
    }
    const [newer, older] = core.listMeetings();
    core.renameParticipant(older!.id, "Speaker 1", "Priya");
    expect(core.getMeetingForDisplay(newer!.id)!.transcript.segments[1]!.speaker).toBe("Speaker 1");
    expect(core.getMeetingForDisplay(older!.id)!.transcript.segments[1]!.speaker).toBe("Priya");
  });

  it("is kept when the Summary is regenerated, which is still written with labels", async () => {
    const engine = new FakeEngine();
    let up = false;
    const core = new AppCore({
      engine,
      store: openStore(":memory:"),
      pipeline: {
        transcribe: pipeline.transcribe,
        summarise: async (t) => {
          if (!up) throw new Error("Ollama is not running");
          return pipeline.summarise(t);
        },
      },
    });
    core.start();
    engine.emit({ type: "ready", version: "0.1.0" });
    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    engine.emit({ type: "tracks_ready", micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav", micStartHostTime: 1, systemStartHostTime: 1 });
    await core.idle();
    const id = core.listMeetings()[0]!.id;
    core.renameParticipant(id, "Speaker 1", "Priya");

    up = true;
    await core.retrySummary(id);
    expect(core.getMeeting(id)!.summary).toEqual(summary);
    expect(core.getMeetingForDisplay(id)!.summary!.participants[1]!.speaker).toBe("Priya");
  });

  it("tells a window that Meetings changed, so it redraws", async () => {
    const { core, id } = await recordedMeeting();
    let changes = 0;
    core.onMeetingsChanged(() => changes++);
    core.renameParticipant(id, "Speaker 1", "Priya");
    expect(changes).toBe(1);
  });

  it("refuses a label the Meeting does not have", async () => {
    const { core, id } = await recordedMeeting();
    expect(() => core.renameParticipant(id, "Speaker 9", "Priya")).toThrow(/no Participant "Speaker 9"/);
    expect(() => core.renameParticipant(999, "Speaker 1", "Priya")).toThrow();
  });
});

describe("the person's own name", () => {
  it("stands in for You in the Transcript, the Summary and the export, for every Meeting", async () => {
    const { core, store, id } = await recordedMeeting();
    expect(core.getMeetingForDisplay(id)!.transcript.segments[0]!.speaker).toBe("You");

    store.setSetting("userName", "Kenny");
    const shown = core.getMeetingForDisplay(id)!;
    expect(shown.transcript.segments[0]!.speaker).toBe("Kenny");
    expect(shown.summary!.participants[0]!.speaker).toBe("Kenny");
    expect(shown.participants.find((p) => p.label === "You")!.name).toBe("Kenny");
    expect(core.exportMeeting(id).markdown).toContain("**Kenny** (0:00): Where are we on the launch?");
  });

  it("gives way to a name chosen for You in that Meeting, and does not change what is stored", async () => {
    const { core, store, id } = await recordedMeeting();
    store.setSetting("userName", "Kenny");
    core.renameParticipant(id, "You", "Ken");
    expect(core.getMeetingForDisplay(id)!.transcript.segments[0]!.speaker).toBe("Ken");
    expect(core.exportMeeting(id).markdown).not.toContain("Kenny");

    store.setSetting("userName", "");
    core.renameParticipant(id, "You", "");
    expect(core.getMeetingForDisplay(id)!.transcript.segments[0]!.speaker).toBe("You");
  });
});

 it('rejects duplicate effective names and disambiguates legacy collisions', async () => {
  const { core, store, id } = await recordedMeeting();
  store.setSetting('userName', 'Alex');
  expect(() => core.renameParticipant(id, 'Speaker 1', ' alex ')).toThrow('distinct name');
  store.renameParticipant(id, 'Speaker 1', 'Alex');
  const shown = core.getMeetingForDisplay(id)!;
  expect(shown.transcript.segments.map(s => s.speaker)).toContain('Alex (You)');
  expect(canonicaliseParticipantMentions('What did Alex (You) say?', shown.participants)).toBe('What did You say?');
  expect(core.exportMeeting(id).markdown).toContain('### Alex (Speaker 1)');
 });
