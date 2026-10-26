import type { Meeting, MeetingListItem, MeetingState } from "../store/store.js";

const esc = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STATE_TEXT: Record<MeetingState, string> = {
  recording: "Recording…",
  processing: "Processing…",
  done: "Done",
  failed: "Failed",
};

/** Links in the page select a Meeting; the window reads them back with `meetingIdFromLink`. */
const meetingLink = (id: number): string => `meeting:${id}`;

export function meetingIdFromLink(url: string): number | undefined {
  const match = /^meeting:(\d+)$/.exec(url);
  return match ? Number(match[1]) : undefined;
}

const clock = (seconds: number): string => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const when = (iso: string): string => new Date(iso).toLocaleString();

function listItem(m: MeetingListItem, selectedId: number | undefined): string {
  const selected = m.id === selectedId ? " selected" : "";
  return `<li><a class="item${selected}" href="${meetingLink(m.id)}">
    <span class="app">${esc(m.app)}</span>
    <span class="when">${esc(when(m.startedAt))}</span>
    <span class="state ${m.state}">${STATE_TEXT[m.state]}</span>
  </a></li>`;
}

function detail(m: Meeting): string {
  const head = `<h1>${esc(m.app)}</h1><p class="when">${esc(when(m.startedAt))}</p>`;
  let body: string;
  switch (m.state) {
    case "recording":
      body = `<p class="notice recording">This Meeting is being recorded.</p>`;
      break;
    case "processing":
      body = `<p class="notice processing">Transcribing and summarising this Meeting…</p>`;
      break;
    case "failed":
      body = `<p class="notice failed">Processing failed: ${esc(m.error ?? "unknown error")}</p>`;
      break;
    case "done":
      body = m.transcript.segments.length ? "" : `<p class="notice">No speech was detected in this Recording.</p>`;
      break;
  }
  const summary = m.summary
    ? `<h2>Summary</h2><p>${esc(m.summary.tldr)}</p>
       ${m.summary.participants
         .map((p) => `<h3>${esc(p.speaker)}</h3><ul>${p.said.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`)
         .join("")}`
    : "";
  const transcript = m.transcript.segments.length
    ? `<h2>Transcript</h2>${m.transcript.segments
        .map(
          (s) =>
            `<p class="segment"><span class="time">${clock(s.start)}</span> <strong>${esc(s.speaker)}</strong> ${esc(s.text)}</p>`,
        )
        .join("")}`
    : "";
  return head + body + summary + transcript;
}

const STYLE = `
  body { font: 13px -apple-system, system-ui, sans-serif; margin: 0; display: flex; height: 100vh; color: #1d1d1f; }
  nav { width: 260px; overflow-y: auto; border-right: 1px solid #d2d2d7; background: #f5f5f7; }
  main { flex: 1; overflow-y: auto; padding: 16px 24px; }
  ul.meetings { list-style: none; margin: 0; padding: 0; }
  a.item { display: block; padding: 10px 14px; color: inherit; text-decoration: none; border-bottom: 1px solid #e5e5ea; }
  a.item.selected { background: #d9e8ff; }
  .app { font-weight: 600; display: block; }
  .when { color: #6e6e73; }
  .state { font-size: 11px; }
  .state.failed { color: #c4001a; }
  .state.recording, .state.processing { color: #b25f00; }
  .notice { padding: 8px 12px; border-radius: 6px; }
  .notice.failed { background: #ffe5e8; color: #c4001a; }
  .notice.recording, .notice.processing { background: #fff1d6; color: #7a4500; }
  .segment { margin: 4px 0; }
  .time { color: #6e6e73; font-variant-numeric: tabular-nums; }
  .empty { color: #6e6e73; padding: 16px; }
`;

/** The whole Meetings window as one HTML page. */
export function renderMeetingsPage(meetings: MeetingListItem[], selected: Meeting | undefined): string {
  const list = meetings.length
    ? `<ul class="meetings">${meetings.map((m) => listItem(m, selected?.id)).join("")}</ul>`
    : `<p class="empty">No Meetings yet.</p>`;
  const main = selected ? detail(selected) : `<p class="empty">Select a Meeting.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head>
<body><nav>${list}</nav><main>${main}</main></body></html>`;
}
