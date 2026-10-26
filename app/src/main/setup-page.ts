import type { SetupState, Step } from "../setup/first-run-setup.js";

const esc = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What each link in the page asks for; the window reads them back with `setupActionFromLink`. */
export const SETUP_ACTIONS = ["microphone", "system-audio", "models", "ollama", "settings-microphone", "settings-system-audio", "done"] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

export function setupActionFromLink(url: string): SetupAction | undefined {
  const match = /^setup:(.+)$/.exec(url);
  return SETUP_ACTIONS.find((a) => a === match?.[1]);
}

const link = (action: SetupAction, label: string): string => `<a class="button" href="setup:${action}">${esc(label)}</a>`;

interface Card {
  title: string;
  explanation: string;
  step: Step;
  button: { action: SetupAction; start: string; again: string };
  /** Shown between the explanation and the button, e.g. a progress bar. */
  extra?: string;
  /** Where to fix a permission that was denied. */
  settings?: SetupAction;
}

function card({ title, explanation, step, button, extra = "", settings }: Card): string {
  const status = {
    todo: link(button.action, button.start),
    working: `<span class="working">Working…</span>`,
    done: `<span class="done">✓ Done</span>`,
    problem: link(button.action, button.again) + (settings ? `<a class="link" href="setup:${settings}">Open System Settings</a>` : ""),
  }[step.status];
  const problem = step.status === "problem" && step.message ? `<p class="problem">${esc(step.message)}</p>` : "";
  return `<section><h2>${esc(title)}</h2><p>${esc(explanation)}</p>${extra}${problem}<div class="action">${status}</div></section>`;
}

const STYLE = `
  body { font: 13px -apple-system, system-ui, sans-serif; margin: 0; padding: 24px 32px; color: #1d1d1f; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  section { border: 1px solid #d2d2d7; border-radius: 8px; padding: 4px 16px 12px; margin: 12px 0; }
  .action { margin-top: 8px; }
  a.button { display: inline-block; padding: 5px 14px; border-radius: 6px; background: #0a64d8; color: #fff; text-decoration: none; }
  a.link { color: #0a64d8; margin-left: 12px; }
  .done { color: #1a7f37; }
  .working { color: #b25f00; }
  .problem { background: #ffe5e8; color: #c4001a; padding: 8px 12px; border-radius: 6px; }
  progress { width: 100%; }
`;

/** The first-run setup window as one HTML page. Every macOS prompt is explained here before its button is pressed. */
export function renderSetupPage(state: SetupState, name: string, complete: boolean): string {
  const progress =
    state.models.status === "working"
      ? `<progress max="100" value="${Math.round(state.models.fraction * 100)}"></progress>
         <p>${state.models.fraction >= 1 ? "Preparing the models…" : `${Math.round(state.models.fraction * 100)}% downloaded`}</p>`
      : "";
  const microphone = card({
    title: "Microphone",
    explanation: `${name} records what you say in a call through your microphone. When you press the button, macOS asks whether to allow it.`,
    step: state.microphone,
    button: { action: "microphone", start: "Allow microphone", again: "Try again" },
    settings: "settings-microphone",
  });
  const systemAudio = card({
    title: "System audio",
    explanation: `${name} records what the other people say by capturing your Mac's audio output. When you press the button, macOS asks whether to allow it.`,
    step: state.systemAudio,
    button: { action: "system-audio", start: "Allow system audio", again: "Try again" },
    settings: "settings-system-audio",
  });
  const models = card({
    title: "Speech and speaker models",
    explanation: `${name} turns speech into text and tells speakers apart on your Mac, with no cloud service. The speech and speaker models need a one-time download.`,
    step: state.models,
    button: { action: "models", start: "Download models", again: "Try again" },
    extra: progress,
  });
  const ollama = card({
    title: "Summaries",
    explanation: "Summaries are written by a model running in Ollama on your Mac. Ollama must be running with the model pulled. You can record without it and summarise later.",
    step: state.ollama,
    button: { action: "ollama", start: "Check Ollama", again: "Check again" },
  });
  const finish = complete
    ? `<section><h2>You're set up</h2><p>${esc(name)} will ask before it records anything.</p><div class="action">${link("done", "Done")}</div></section>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
<h1>Welcome to ${esc(name)}</h1><p>A few things to set up before the first call. Everything stays on this Mac.</p>
${microphone}${systemAudio}${models}${ollama}${finish}</body></html>`;
}
