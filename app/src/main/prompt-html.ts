export const RECORD_URL = "prompt://record";
export const NOT_NOW_URL = "prompt://not-now";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The buttons are links; the main process catches the navigation, so the page needs no preload or Node access. */
export function promptHtml(app: string): string {
  return `<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; background: transparent; -webkit-user-select: none; cursor: default; }
    body { font: 13px/1.35 -apple-system, system-ui, sans-serif; color: #1d1d1f; }
    .card { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-radius: 16px;
            background: rgba(248, 248, 250, 0.98); border: 1px solid rgba(0, 0, 0, 0.1); }
    .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: #d92d20;
           box-shadow: 0 0 0 4px rgba(217, 45, 32, 0.18); }
    .text { flex: 1; min-width: 0; }
    h1 { font-size: 13px; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
    p { margin: 2px 0 0; color: #6e6e73; font-size: 12px; }
    .buttons { flex: none; display: flex; gap: 8px; }
    a { padding: 6px 14px; border-radius: 8px; text-decoration: none; font-weight: 500; white-space: nowrap;
        color: #1d1d1f; background: rgba(0, 0, 0, 0.07); }
    a:hover { background: rgba(0, 0, 0, 0.12); }
    a.record { color: #fff; background: #d92d20; }
    a.record:hover { background: #b9251a; }
    a:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      body { color: #f5f5f7; }
      .card { background: rgba(44, 44, 46, 0.98); border-color: rgba(255, 255, 255, 0.14); }
      p { color: #a1a1a6; }
      a { color: #f5f5f7; background: rgba(255, 255, 255, 0.14); }
      a:hover { background: rgba(255, 255, 255, 0.22); }
      a.record { background: #e5392c; }
      a.record:hover { background: #f0554a; }
    }
  </style>
  <div class="card">
    <span class="dot"></span>
    <div class="text">
      <h1>${escapeHtml(app)} is using your microphone</h1>
      <p>Record this Meeting? Nothing is kept unless you do.</p>
    </div>
    <div class="buttons"><a class="record" href="${RECORD_URL}">Record</a><a href="${NOT_NOW_URL}">Not now</a></div>
  </div>`;
}
